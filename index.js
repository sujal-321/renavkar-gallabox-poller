'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const { KeyedSerialQueue } = require('./keyed_queue');
const { JsonStateStore } = require('./state_store');
const {
  extractAudioUrl,
  getPhone,
  getMessageId,
  isInbound,
  normalizeMessage
} = require('./message_utils');

function numberEnv(name, fallback, minimum = 0) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function parseAllowedPhones() {
  const raw = String(process.env.RENAVKAR_ALLOWED_PHONES || '9014998200,9714991000').trim();
  if (raw === '*') return { allowAll: true, phones: [] };
  return { allowAll: false, phones: raw.split(',').map(value => value.replace(/[^0-9]/g, '')).filter(Boolean) };
}

const config = {
  accountId: process.env.GALLABOX_ACCOUNT_ID || '',
  apiKey: process.env.GALLABOX_API_KEY || '',
  apiSecret: process.env.GALLABOX_API_SECRET || '',
  channelId: process.env.GALLABOX_CHANNEL_ID || '',
  openAiKey: process.env.OPENAI_API_KEY || '',
  n8nUrl: String(process.env.N8N_URL || 'https://n8n-production-e558.up.railway.app').replace(/\/$/, ''),
  n8nInternalSecret: process.env.N8N_INTERNAL_SECRET || '',
  allowed: parseAllowedPhones(),
  pollIntervalMs: numberEnv('RENAVKAR_POLL_INTERVAL_MS', 15000, 1000),
  gallaboxRequestIntervalMs: numberEnv('RENAVKAR_GALLABOX_REQUEST_INTERVAL_MS', 1000, 0),
  gallaboxRateLimitBackoffMs: numberEnv('RENAVKAR_GALLABOX_RATE_LIMIT_BACKOFF_MS', 60000, 1000),
  apiTimeoutMs: numberEnv('RENAVKAR_API_TIMEOUT_MS', 15000, 1000),
  maxAudioBytes: numberEnv('RENAVKAR_MAX_AUDIO_BYTES', 15 * 1024 * 1024, 1024),
  maxConversations: numberEnv('RENAVKAR_MAX_CONVERSATIONS', 25, 1),
  maxMessagesPerConversation: numberEnv('RENAVKAR_MAX_MESSAGES', 20, 1),
  conversationLookbackMs: numberEnv('RENAVKAR_CONVERSATION_LOOKBACK_MS', 5 * 60 * 1000, 60000),
  contactCacheTtlMs: numberEnv('RENAVKAR_CONTACT_CACHE_TTL_MS', 60 * 60 * 1000, 60000),
  seedAgeMs: numberEnv('RENAVKAR_SEED_AGE_MS', 120000, 0),
  seedHistoryEnabled: process.env.RENAVKAR_SEED_HISTORY_ENABLED === 'true',
  stateFile: process.env.RENAVKAR_STATE_FILE || path.join(__dirname, 'data', 'renavkar-state.json'),
  stateRetentionMs: numberEnv('RENAVKAR_STATE_RETENTION_MS', 7 * 24 * 60 * 60 * 1000, 60000),
  // Outbound campaigns must be explicitly enabled. Inbound bot testing must never message sheet leads by default.
  outboundCheckEnabled: process.env.RENAVKAR_OUTBOUND_CHECK_ENABLED === 'true'
};

function validateConfig() {
  for (const name of ['GALLABOX_ACCOUNT_ID', 'GALLABOX_API_KEY', 'GALLABOX_API_SECRET', 'GALLABOX_CHANNEL_ID', 'OPENAI_API_KEY']) {
    if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
  }
}

function requestBuffer(urlString, { method = 'GET', headers = {}, body = null, timeoutMs = config.apiTimeoutMs, maxBytes = Infinity } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const client = url.protocol === 'http:' ? http : https;
    const request = client.request(url, { method, headers }, response => {
      const chunks = [];
      let total = 0;

      response.on('data', chunk => {
        total += chunk.length;
        if (total <= maxBytes) chunks.push(chunk);
      });
      response.on('end', () => {
        if (total > maxBytes) return reject(new Error(`Response exceeded ${maxBytes} bytes`));
        const buffer = Buffer.concat(chunks);
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          return resolve({ redirect: new URL(response.headers.location, url).toString() });
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          return reject(new Error(`HTTP ${response.statusCode}: ${buffer.toString('utf8').slice(0, 500)}`));
        }
        resolve({ statusCode: response.statusCode, headers: response.headers, buffer });
      });
    });

    request.setTimeout(timeoutMs, () => request.destroy(new Error(`Request timed out after ${timeoutMs}ms`)));
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function createThrottledFetch(fetchFn, intervalMs) {
  let lastRequestAt = 0;
  let blockedUntil = 0;
  let chain = Promise.resolve();

  return (...args) => {
    const request = chain.then(async () => {
      const waitMs = Math.max(0, intervalMs - (Date.now() - lastRequestAt), blockedUntil - Date.now());
      if (waitMs) await sleep(waitMs);
      try {
        const result = await fetchFn(...args);
        lastRequestAt = Date.now();
        return result;
      } catch (error) {
        if (/HTTP 429/.test(error.message)) {
          blockedUntil = Date.now() + config.gallaboxRateLimitBackoffMs;
          console.error(`Gallabox rate limit reached; backing off for ${config.gallaboxRateLimitBackoffMs}ms`);
        }
        throw error;
      }
    });
    chain = request.catch(() => undefined);
    return request;
  };
}

async function fetchGallabox(apiPath) {
  const result = await requestBuffer(`https://server.gallabox.com/devapi/accounts/${config.accountId}${apiPath}`, {
    headers: {
      apiKey: config.apiKey,
      apiSecret: config.apiSecret,
      Accept: 'application/json'
    }
  });
  return JSON.parse(result.buffer.toString('utf8'));
}

async function downloadMediaBuffer(urlString, redirectCount = 0) {
  if (!urlString || redirectCount > 3) return null;

  try {
    const result = await requestBuffer(urlString, { maxBytes: config.maxAudioBytes });
    if (result.redirect) return downloadMediaBuffer(result.redirect, redirectCount + 1);
    return result.buffer;
  } catch (error) {
    console.error(`Audio download failed: ${error.message}`);
    return null;
  }
}

function transcribeVoiceNoteBuffer(buffer) {
  return new Promise((resolve, reject) => {
    if (!buffer?.length) return reject(new Error('Voice note is empty'));
    if (!config.openAiKey) return reject(new Error('OPENAI_API_KEY is not configured'));

    const boundary = `----RenavkarBoundary${Math.random().toString(16).slice(2)}`;
    const header = Buffer.from(
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="file"; filename="voice-note.ogg"\r\n' +
      'Content-Type: audio/ogg\r\n\r\n',
      'utf8'
    );
    const fields = Buffer.from(
      `\r\n--${boundary}\r\n` +
      'Content-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n' +
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="prompt"\r\n\r\nIndian English Hinglish real estate voice note about Avestia Stay, studio apartment price and ROI\r\n' +
      `--${boundary}--\r\n`,
      'utf8'
    );
    const body = Buffer.concat([header, buffer, fields]);

    requestBuffer('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openAiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      },
      body,
      maxBytes: 1024 * 1024
    })
      .then(result => {
        const payload = JSON.parse(result.buffer.toString('utf8'));
        if (!payload.text?.trim()) throw new Error(payload.error?.message || 'Transcription was empty');
        resolve(payload.text.trim());
      })
      .catch(reject);
  });
}

function arrayFromApiResponse(value) {
  return Array.isArray(value) ? value : (Array.isArray(value?.data) ? value.data : []);
}

function isAllowedPhone(phone) {
  return config.allowed.allowAll || config.allowed.phones.some(allowed => phone.includes(allowed));
}

function messageTimestamp(message) {
  const timestamp = new Date(message?.createdAt || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function parseDispatchAck(responseText, expectedMessageId) {
  let ack;
  try {
    ack = JSON.parse(responseText);
  } catch (error) {
    throw new Error(`n8n returned a non-JSON acknowledgement: ${String(responseText).slice(0, 200)}`);
  }

  if (ack?.ok !== true) throw new Error('n8n did not confirm that the WhatsApp reply was handled');
  if (String(ack.message_id || '') !== String(expectedMessageId || '')) {
    throw new Error(`n8n acknowledgement message mismatch: expected ${expectedMessageId}, received ${ack?.message_id || 'empty'}`);
  }
  return ack;
}

async function sendToN8n(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': body.length,
    'x-renavkar-source': 'gallabox-poller'
  };
  if (config.n8nInternalSecret) headers['x-renavkar-internal-secret'] = config.n8nInternalSecret;

  const result = await requestBuffer(`${config.n8nUrl}/webhook/renavkar-whatsapp`, {
    method: 'POST',
    headers,
    body
  });

  return parseDispatchAck(result.buffer.toString('utf8'), payload.message_id);
}

async function checkOutboundLeads() {
  if (!config.outboundCheckEnabled) return;
  try {
    await requestBuffer(`${config.n8nUrl}/webhook/renavkar-outbound-trigger`, {
      headers: config.n8nInternalSecret ? { 'x-renavkar-internal-secret': config.n8nInternalSecret } : {}
    });
  } catch (error) {
    console.error(`Outbound lead check failed: ${error.message}`);
  }
}

async function enrichVoiceMessage(message, contact) {
  const audioUrl = extractAudioUrl(message);
  if (!audioUrl) return normalizeMessage(message, { contact, contactId: message.contactId });

  const audio = await downloadMediaBuffer(audioUrl);
  if (!audio) {
    return normalizeMessage(message, {
      contact,
      contactId: message.contactId,
      transcriptionError: new Error('Audio download failed')
    });
  }

  try {
    const transcription = await transcribeVoiceNoteBuffer(audio);
    return normalizeMessage(message, { contact, contactId: message.contactId, transcription });
  } catch (error) {
    console.error(`Voice transcription failed: ${error.message}`);
    return normalizeMessage(message, { contact, contactId: message.contactId, transcriptionError: error });
  }
}

function createPoller({ fetch = fetchGallabox, dispatch = sendToN8n, store, queue = new KeyedSerialQueue() } = {}) {
  let polling = false;
  const contactCache = new Map();

  async function getContact(conversation) {
    if (getPhone(conversation?.contact)) return conversation.contact;
    const cached = contactCache.get(conversation.contactId);
    if (cached && Date.now() - cached.cachedAt < config.contactCacheTtlMs) return cached.contact;
    const contact = await fetch(`/contacts/${conversation.contactId}`);
    if (contact) contactCache.set(conversation.contactId, { contact, cachedAt: Date.now() });
    return contact;
  }

  async function processMessage(message, contact) {
    const contactId = message.contactId;
    const candidateMessageId = getMessageId(message, contactId);
    const previous = store.getMessage(candidateMessageId);
    if (previous?.status === 'done' || previous?.status === 'seeded') return;

    const normalized = await enrichVoiceMessage({ ...message, contactId }, contact);
    const messageId = normalized.message_id;
    const phone = normalized.sender_phone;
    if (!phone || !isAllowedPhone(phone)) return;

    const attempts = Number(previous?.attempts || 0) + 1;
    store.mark(messageId, {
      status: 'processing',
      attempts,
      createdAt: normalized.received_at,
      phone,
      contactId,
      lastError: ''
    });

    try {
      await dispatch({
        event: 'message.received',
        contact: { phone: `+${phone}`, name: normalized.sender_name },
        message: { text: normalized.message_text },
        message_id: normalized.message_id,
        conversation_id: normalized.conversation_id,
        button_payload: normalized.button_payload,
        button_text: normalized.button_text,
        voice_note_status: normalized.voice_note_status,
        voice_note_transcription: normalized.voice_note_transcription,
        source: normalized.source,
        received_at: normalized.received_at
      });
      store.mark(messageId, { status: 'done', completedAt: new Date().toISOString() });
      console.log(`Processed ${messageId} for ${phone}`);
    } catch (error) {
      store.mark(messageId, { status: 'failed', lastError: error.message, failedAt: new Date().toISOString() });
      console.error(`Dispatch failed for ${messageId}: ${error.message}`);
    }
  }

  async function scanConversation(conversation) {
    if (!conversation?.contactId) return;

    const messagesResponse = await fetch(`/messages?channelId=${encodeURIComponent(config.channelId)}&contactId=${encodeURIComponent(conversation.contactId)}&limit=${config.maxMessagesPerConversation}`);
    const messages = arrayFromApiResponse(messagesResponse)
      .filter(message => isInbound(message, conversation.contactId))
      .sort((a, b) => messageTimestamp(a) - messageTimestamp(b));

    const hasProcessableMessage = messages.some(message => {
      const existing = store.getMessage(getMessageId(message, conversation.contactId));
      const age = Date.now() - messageTimestamp(message);
      if (!existing && age <= config.seedAgeMs) return true;
      if (existing?.status === 'failed' && Date.now() - new Date(existing.failedAt || 0).getTime() >= 10000) return true;
      if (existing?.status === 'processing' && Date.now() - new Date(existing.updatedAt || 0).getTime() >= config.apiTimeoutMs * 2) return true;
      return false;
    });
    if (!hasProcessableMessage) return;

    const contact = await getContact(conversation);
    if (!contact) return;

    for (const message of messages) {
      const messageId = getMessageId(message, conversation.contactId);
      const existing = store.getMessage(messageId);
      const age = Date.now() - messageTimestamp(message);

      if (!existing && age > config.seedAgeMs) {
        store.mark(messageId, { status: 'seeded', createdAt: message.createdAt, contactId: conversation.contactId });
        continue;
      }
      if (existing?.status === 'processing' && Date.now() - new Date(existing.updatedAt).getTime() < config.apiTimeoutMs * 2) continue;
      if (existing?.status === 'failed' && Date.now() - new Date(existing.failedAt || 0).getTime() < 10000) continue;

      const phone = getPhone(contact);
      if (!phone || !isAllowedPhone(phone)) continue;
      await queue.run(phone, () => processMessage({ ...message, contactId: conversation.contactId }, contact));
    }
  }

  async function pollOnce() {
    if (polling) return;
    polling = true;
    try {
      const conversations = arrayFromApiResponse(await fetch(`/conversations?channelId=${encodeURIComponent(config.channelId)}&limit=${config.maxConversations}`));
      for (const conversation of conversations) {
        const updatedAt = new Date(conversation?.updatedAt || conversation?.lastMessageAt || 0).getTime();
        if (updatedAt && Date.now() - updatedAt > config.conversationLookbackMs) continue;
        await scanConversation(conversation).catch(error => {
          console.error(`Conversation scan failed: ${error.message}`);
        });
      }
      store.prune(config.stateRetentionMs);
    } finally {
      polling = false;
    }
  }

  return { pollOnce, processMessage, scanConversation };
}

async function seedHistoricalMessages(store, fetchFn) {
  const conversations = arrayFromApiResponse(await fetchFn(`/conversations?channelId=${encodeURIComponent(config.channelId)}&limit=${config.maxConversations}`));
  const cutoff = Date.now() - config.seedAgeMs;
  for (const conversation of conversations) {
    if (!conversation?.contactId) continue;
    const messages = arrayFromApiResponse(await fetchFn(`/messages?channelId=${encodeURIComponent(config.channelId)}&contactId=${encodeURIComponent(conversation.contactId)}&limit=${config.maxMessagesPerConversation}`));
    for (const message of messages) {
      if (isInbound(message, conversation.contactId) && messageTimestamp(message) < cutoff) {
        store.mark(getMessageId(message, conversation.contactId), { status: 'seeded', createdAt: message.createdAt, contactId: conversation.contactId });
      }
    }
  }
}

async function main() {
  validateConfig();
  const store = new JsonStateStore(config.stateFile);
  store.load();
  const throttledFetch = createThrottledFetch(fetchGallabox, config.gallaboxRequestIntervalMs);
  if (config.seedHistoryEnabled) {
    try {
      await seedHistoricalMessages(store, throttledFetch);
    } catch (error) {
      console.error(`Historical message seeding skipped: ${error.message}`);
    }
  }

  const poller = createPoller({ store, fetch: throttledFetch });
  console.log(`Renavkar poller active; interval=${config.pollIntervalMs}ms, Gallabox request interval=${config.gallaboxRequestIntervalMs}ms, state=${config.stateFile}`);
  try {
    await poller.pollOnce();
  } catch (error) {
    console.error(`Initial polling cycle failed: ${error.message}`);
  }

  const interval = setInterval(() => poller.pollOnce().catch(error => console.error(`Polling cycle failed: ${error.message}`)), config.pollIntervalMs);
  const outboundInterval = setInterval(() => checkOutboundLeads(), 60000);

  const shutdown = () => {
    clearInterval(interval);
    clearInterval(outboundInterval);
    store.save();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  arrayFromApiResponse,
  config,
  createPoller,
  createThrottledFetch,
  downloadMediaBuffer,
  isAllowedPhone,
  normalizeMessage,
  parseDispatchAck,
  seedHistoricalMessages,
  transcribeVoiceNoteBuffer
};
