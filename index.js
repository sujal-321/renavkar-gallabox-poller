'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

// Auto-load .env from current or parent directory
const envLocations = [path.join(__dirname, '.env'), path.join(__dirname, '..', '.env')];
for (const envFile of envLocations) {
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([^#=]+)=(.*)$/);
      if (!match) continue;
      const name = match[1].trim();
      if (!process.env[name]) process.env[name] = match[2].trim();
    }
  }
}

const { KeyedSerialQueue } = require('./keyed_queue');
const { JsonStateStore } = require('./state_store');
const { MessageDebouncer } = require('./debouncer');
const { processUncontactedLeads } = require('./outbound_dispatcher');
const { sendDiscordAlert } = require('./discord_alerter');
const {
  extractAudioUrl,
  getPhone,
  getMessageId,
  isInbound,
  normalizeMessage
} = require('./message_utils');
const { handleDirectAiMessage } = require('./ai_agent');

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
  const rawEnv = process.env.RENAVKAR_ALLOWED_PHONES || process.env.ALLOWED_PHONES || '';
  const devPhone = process.env.DEV_PHONE || '';
  const defaultTestPhones = ['9014998200', '9714991000'];

  if (rawEnv.trim() === '*' || process.env.ALLOW_ALL_PHONES === 'true') {
    return { allowAll: true, phones: [] };
  }

  // Merge explicitly provided envs with the default test numbers (Sujal + Arihant)
  const rawList = `${rawEnv},${devPhone},${defaultTestPhones.join(',')}`;
  const phoneSet = new Set();
  for (const part of rawList.split(',')) {
    const cleaned = String(part || '').replace(/[^0-9]/g, '');
    if (cleaned.length >= 10) {
      phoneSet.add(cleaned.slice(-10));
    } else if (cleaned) {
      phoneSet.add(cleaned);
    }
  }

  return { allowAll: false, phones: Array.from(phoneSet) };
}

const keepAliveHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 50, keepAliveMsecs: 30000 });
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50, keepAliveMsecs: 30000 });

const config = {
  accountId: process.env.GALLABOX_ACCOUNT_ID || '',
  apiKey: process.env.GALLABOX_API_KEY || '',
  apiSecret: process.env.GALLABOX_API_SECRET || '',
  channelId: process.env.GALLABOX_CHANNEL_ID || '',
  openAiKey: process.env.OPENAI_API_KEY || '',
  n8nUrl: String(process.env.N8N_URL || 'https://n8n-production-e558.up.railway.app').replace(/\/$/, ''),
  n8nInternalSecret: process.env.N8N_INTERNAL_SECRET || '',
  allowed: parseAllowedPhones(),
  googleSheetWebhookUrl: process.env.GOOGLE_SHEET_WEBHOOK_URL || 'https://script.google.com/macros/s/AKfycbxkqQmgrTR3Wd7whI7Z-Fy2BhuUq43wB6q86nqHxWozWdKm_VDPF0nMZMTnlu7buyAh_w/exec',
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || 'https://discord.com/api/webhooks/1538878377619103755/XdWLsC0g83LovfxxQi__hwMcn_r0PIIZdSwbsPIDaLKp8h3jIbOqmagS8M13fmNbENa3',
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseKey: process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  humanTakeoverTimeoutMs: numberEnv('RENAVKAR_HUMAN_TAKEOVER_TIMEOUT_MS', 30 * 60 * 1000, 60000),
  debounceMs: process.env.RENAVKAR_DEBOUNCE_MS ? Number(process.env.RENAVKAR_DEBOUNCE_MS) : null,
  activePollIntervalMs: numberEnv('RENAVKAR_ACTIVE_POLL_INTERVAL_MS', 1000, 500),
  idlePollIntervalMs: numberEnv('RENAVKAR_IDLE_POLL_INTERVAL_MS', 1500, 500),
  pollIntervalMs: numberEnv('RENAVKAR_POLL_INTERVAL_MS', 1500, 500),
  gallaboxRequestIntervalMs: numberEnv('RENAVKAR_GALLABOX_REQUEST_INTERVAL_MS', 250, 0),
  gallaboxRateLimitBackoffMs: numberEnv('RENAVKAR_GALLABOX_RATE_LIMIT_BACKOFF_MS', 60000, 1000),
  apiTimeoutMs: numberEnv('RENAVKAR_API_TIMEOUT_MS', 5000, 1000),
  maxAudioBytes: numberEnv('RENAVKAR_MAX_AUDIO_BYTES', 15 * 1024 * 1024, 1024),
  maxConversations: numberEnv('RENAVKAR_MAX_CONVERSATIONS', 25, 1),
  maxMessagesPerConversation: numberEnv('RENAVKAR_MAX_MESSAGES', 20, 1),
  conversationLookbackMs: numberEnv('RENAVKAR_CONVERSATION_LOOKBACK_MS', 10 * 60 * 1000, 60000),
  contactCacheTtlMs: numberEnv('RENAVKAR_CONTACT_CACHE_TTL_MS', 60 * 60 * 1000, 60000),
  seedAgeMs: numberEnv('RENAVKAR_SEED_AGE_MS', 15 * 60 * 1000, 0),
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
  if (!process.env.SUPABASE_URL || (!process.env.SUPABASE_KEY && !process.env.SUPABASE_SERVICE_ROLE_KEY)) {
    console.warn('⚠️ [Config] SUPABASE_URL or SUPABASE_KEY not provided; lead state & memory will operate via local high-speed in-memory store.');
  }
}

function requestBuffer(urlString, { method = 'GET', headers = {}, body = null, timeoutMs = config.apiTimeoutMs, maxBytes = Infinity } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const client = url.protocol === 'http:' ? http : https;
    const agent = url.protocol === 'http:' ? keepAliveHttpAgent : keepAliveHttpsAgent;
    const request = client.request(url, { method, headers, agent }, response => {
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
  if (config.allowed.allowAll) return true;
  const clean = String(phone || '').replace(/[^0-9]/g, '');
  if (!clean) return false;
  const last10 = clean.length >= 10 ? clean.slice(-10) : clean;
  return config.allowed.phones.some(allowed => {
    const allowedClean = String(allowed).replace(/[^0-9]/g, '');
    const allowedLast10 = allowedClean.length >= 10 ? allowedClean.slice(-10) : allowedClean;
    return clean === allowedClean || clean.includes(allowedClean) || last10 === allowedLast10;
  });
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

async function defaultDispatch(payload) {
  if (process.env.USE_DIRECT_AI !== 'false') {
    return handleDirectAiMessage(payload, config);
  }
  try {
    return await sendToN8n(payload);
  } catch (err) {
    console.warn(`[Poller] n8n dispatch failed (${err.message}). Seamlessly executing Direct AI Agent...`);
    return await handleDirectAiMessage(payload, config);
  }
}

async function checkOutboundLeads() {
  if (config.googleSheetWebhookUrl) {
    try {
      await processUncontactedLeads(config);
    } catch (error) {
      console.error(`Outbound lead check failed: ${error.message}`);
    }
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

function createPoller({ fetch = fetchGallabox, dispatch = defaultDispatch, store, queue = new KeyedSerialQueue(), debounceMs = config.debounceMs } = {}) {
  let polling = false;
  const contactCache = new Map();

  const debouncer = new MessageDebouncer({
    debounceMs,
    onFlush: async (bundledPayload, contact, allMessageIds) => {
      const phone = bundledPayload.sender_phone;
      const primaryMessageId = bundledPayload.message_id;

      return queue.run(phone, async () => {
        try {
          await dispatch({
            event: 'message.received',
            sender_phone: phone,
            sender_name: bundledPayload.sender_name,
            message_text: bundledPayload.message_text,
            contact: { phone: `+${phone}`, name: bundledPayload.sender_name },
            message: { text: bundledPayload.message_text },
            message_id: primaryMessageId,
            conversation_id: bundledPayload.conversation_id,
            button_payload: bundledPayload.button_payload,
            button_text: bundledPayload.button_text,
            voice_note_status: bundledPayload.voice_note_status,
            voice_note_transcription: bundledPayload.voice_note_transcription,
            source: bundledPayload.source,
            received_at: bundledPayload.received_at,
            bundled_message_ids: allMessageIds
          });

          for (const id of allMessageIds) {
            store.mark(id, { status: 'done', completedAt: new Date().toISOString() });
          }
          console.log(`Processed bundled messages [${allMessageIds.join(', ')}] for ${phone}`);
          return { ok: true, message_id: primaryMessageId, reply_sent: true };
        } catch (error) {
          for (const id of allMessageIds) {
            store.mark(id, { status: 'failed', lastError: error.message, failedAt: new Date().toISOString() });
          }
          console.error(`Dispatch failed for [${allMessageIds.join(', ')}]: ${error.message}`);
          throw error;
        }
      });
    }
  });

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

    if (debounceMs !== 0) {
      return debouncer.push(phone, normalized, contact);
    } else {
      return debouncer.onFlush(normalized, contact, [messageId]);
    }
  }

  const humanTakeoverMap = new Map();

  async function scanConversation(conversation) {
    if (!conversation?.contactId) return;

    const contact = await getContact(conversation);
    if (!contact) return;

    const phone = getPhone(contact);
    if (!phone || !isAllowedPhone(phone)) return;

    const messagesResponse = await fetch(`/messages?channelId=${encodeURIComponent(config.channelId)}&contactId=${encodeURIComponent(conversation.contactId)}&limit=${config.maxMessagesPerConversation}`);
    const allMessages = arrayFromApiResponse(messagesResponse);
    const messages = allMessages
      .filter(message => isInbound(message, conversation.contactId))
      .sort((a, b) => messageTimestamp(a) - messageTimestamp(b));

    // Human Takeover Detection: Check if human staff responded manually
    for (const msg of allMessages) {
      if (!isInbound(msg, conversation.contactId)) {
        if (msg.user || msg.source === 'agent' || msg.source === 'inbox' || msg.senderType === 'user') {
          const age = Date.now() - messageTimestamp(msg);
          if (age < config.humanTakeoverTimeoutMs) {
            const isFirstDetection = !humanTakeoverMap.has(phone);
            humanTakeoverMap.set(phone, Date.now());
            if (isFirstDetection) debouncer.clearPhone(phone);
            if (isFirstDetection) {
              sendDiscordAlert({
                webhookUrl: config.discordWebhookUrl,
                title: '👤 Human Agent Takeover Active',
                description: `Human staff message detected for **${contact.name || 'Investor'}** (\`+${phone}\`). AI bot paused for 30 minutes.`,
                phone,
                level: 'warn'
              });
            }
          }
        }
      }
    }

    const lastHumanTakeover = humanTakeoverMap.get(phone);
    if (lastHumanTakeover && Date.now() - lastHumanTakeover < config.humanTakeoverTimeoutMs) {
      console.log(`[Human Takeover] Bot paused for ${phone} due to recent human activity`);
      return;
    }

    const pendingMessages = [];
    for (const message of messages) {
      const messageId = getMessageId(message, conversation.contactId);
      const existing = store.getMessage(messageId);
      const age = Date.now() - messageTimestamp(message);

      if (existing?.status === 'done' || existing?.status === 'seeded') continue;

      if (!existing && age > config.seedAgeMs) {
        store.mark(messageId, { status: 'seeded', createdAt: message.createdAt, contactId: conversation.contactId });
        continue;
      }

      if (existing?.status === 'processing' && Date.now() - new Date(existing.updatedAt).getTime() < config.apiTimeoutMs * 2) continue;
      if (existing?.status === 'failed' && Date.now() - new Date(existing.failedAt || 0).getTime() < 10000) continue;

      pendingMessages.push(message);
    }

    if (pendingMessages.length === 0) return;

    // Track active inbound conversation for dynamic burst micro-polling
    lastInboundActivityAt = Date.now();

    await Promise.all(
      pendingMessages.map(message => processMessage({ ...message, contactId: conversation.contactId }, contact))
    );
  }

  async function pollOnce() {
    if (polling) return;
    polling = true;
    try {
      const conversations = arrayFromApiResponse(await fetch(`/conversations?channelId=${encodeURIComponent(config.channelId)}&limit=${config.maxConversations}`));
      
      // Sort newest conversations first so active messages are discovered in the first 50ms
      conversations.sort((a, b) => {
        const timeA = new Date(a?.updatedAt || a?.lastMessageAt || 0).getTime();
        const timeB = new Date(b?.updatedAt || b?.lastMessageAt || 0).getTime();
        return timeB - timeA;
      });

      for (const conversation of conversations) {
        const updatedAt = new Date(conversation?.updatedAt || conversation?.lastMessageAt || 0).getTime();
        if (updatedAt && Date.now() - updatedAt > config.conversationLookbackMs) continue;

        // Fast-path whitelist filter before fetching messages
        const contactPhone = getPhone(conversation?.contact) || getPhone(contactCache.get(conversation?.contactId)?.contact);
        if (contactPhone && !isAllowedPhone(contactPhone)) {
          continue;
        }

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

let lastInboundActivityAt = 0;

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
  console.log(`Renavkar poller active; burstInterval=${config.activePollIntervalMs}ms, idleInterval=${config.idlePollIntervalMs}ms, state=${config.stateFile}`);
  try {
    await poller.pollOnce();
    await checkOutboundLeads();
  } catch (error) {
    console.error(`Initial polling/outbound cycle failed: ${error.message}`);
  }

  let running = true;
  let pollTimer = null;

  async function scheduleNextPoll() {
    if (!running) return;
    try {
      await poller.pollOnce();
    } catch (error) {
      console.error(`Polling cycle failed: ${error.message}`);
    }
    const isActive = Date.now() - lastInboundActivityAt < 90000;
    const nextInterval = isActive ? config.activePollIntervalMs : config.idlePollIntervalMs;
    pollTimer = setTimeout(scheduleNextPoll, nextInterval);
  }

  pollTimer = setTimeout(scheduleNextPoll, config.activePollIntervalMs);
  const outboundInterval = setInterval(() => checkOutboundLeads(), 15000);

  const shutdown = () => {
    running = false;
    if (pollTimer) clearTimeout(pollTimer);
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
  main,
  normalizeMessage,
  parseDispatchAck,
  seedHistoricalMessages,
  transcribeVoiceNoteBuffer
};
