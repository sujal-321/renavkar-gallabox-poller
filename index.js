const https = require('https');
const http = require('http');

const accountId = '67a9c520769cafdc2619b890';
const apiKey = '6a6c3d954e9f17dacc3852c8';
const apiSecret = '59b1427962cc45be88a6fa600274ad84';
const channelId = '6810a60fc082cc5328b8f64f';

// Read OpenAI Key from Environment Variable (injected via Railway dashboard / env)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

// Whitelisted test phone numbers (Sujal Darla & Arihant Bhura)
const TEST_PHONES = ['9014998200', '9714991000'];
const CLOUD_N8N_HOST = 'n8n-production-e558.up.railway.app';

const processedMessageIds = new Set();
const lastProcessedTimes = new Map();

function fetchGallabox(path) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'server.gallabox.com',
      path: `/devapi/accounts/${accountId}${path}`,
      method: 'GET',
      headers: {
        'apiKey': apiKey,
        'apiSecret': apiSecret,
        'Content-Type': 'application/json'
      }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

function downloadMediaBuffer(urlStr) {
  return new Promise((resolve) => {
    try {
      const client = urlStr.startsWith('https') ? https : http;
      client.get(urlStr, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return downloadMediaBuffer(res.headers.location).then(resolve);
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', (e) => {
        console.error('Audio download error:', e.message);
        resolve(null);
      });
    } catch(e) {
      console.error('Audio download exception:', e.message);
      resolve(null);
    }
  });
}

function transcribeVoiceNoteBuffer(buffer) {
  return new Promise((resolve) => {
    if (!buffer || buffer.length === 0 || !OPENAI_API_KEY) {
      if (!OPENAI_API_KEY) console.error('⚠️ OPENAI_API_KEY is not set in environment.');
      return resolve(null);
    }

    const boundary = '----WebKitFormBoundary' + Math.random().toString(16).substring(2);
    
    let header = `--${boundary}\r\n`;
    header += `Content-Disposition: form-data; name="file"; filename="audio.ogg"\r\n`;
    header += `Content-Type: audio/ogg\r\n\r\n`;

    let fields = `\r\n--${boundary}\r\n`;
    fields += `Content-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`;
    fields += `--${boundary}\r\n`;
    fields += `Content-Disposition: form-data; name="prompt"\r\n\r\nIndian English Hinglish real estate voice note Avestia Stay studio apartment price ROI\r\n`;
    fields += `--${boundary}--\r\n`;

    const bodyBuffer = Buffer.concat([
      Buffer.from(header, 'utf8'),
      buffer,
      Buffer.from(fields, 'utf8')
    ]);

    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/audio/transcriptions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': bodyBuffer.length
      }
    }, (res) => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(b);
          if (parsed.error) console.error('Whisper API Error:', parsed.error);
          resolve(parsed.text || null);
        } catch(e) {
          console.error('Whisper parse error:', e.message);
          resolve(null);
        }
      });
    });

    req.on('error', (err) => {
      console.error('Whisper transcription request error:', err.message);
      resolve(null);
    });

    req.write(bodyBuffer);
    req.end();
  });
}

async function pollOnce() {
  try {
    const convs = await fetchGallabox(`/conversations?channelId=${channelId}&limit=15`);
    const items = Array.isArray(convs) ? convs : convs?.data || [];

    for (const conv of items) {
      if (!conv || !conv.contactId) continue;

      const contact = await fetchGallabox(`/contacts/${conv.contactId}`);
      if (!contact) continue;

      const phoneList = contact.phone || [];
      const rawPhone = phoneList[0] || '';
      const cleanPhone = String(rawPhone).replace(/[^0-9]/g, '');

      const isWhitelisted = TEST_PHONES.some(p => cleanPhone.includes(p));
      if (!isWhitelisted) continue;

      const lastTime = lastProcessedTimes.get(cleanPhone) || 0;
      if (Date.now() - lastTime < 8000) {
        continue;
      }

      const msgs = await fetchGallabox(`/messages?channelId=${channelId}&contactId=${conv.contactId}&limit=5`);
      const msgList = Array.isArray(msgs) ? msgs : msgs?.data || [];

      const customerMsgs = msgList.filter(m => m.sender === conv.contactId);
      if (customerMsgs.length === 0) continue;

      customerMsgs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      const newestCustomerMsg = customerMsgs[0];

      const msgId = newestCustomerMsg.id || `${newestCustomerMsg.createdAt}_${newestCustomerMsg.whatsapp?.text?.body}`;
      if (processedMessageIds.has(msgId)) continue;

      let msgText = newestCustomerMsg.whatsapp?.text?.body || newestCustomerMsg.text?.body || newestCustomerMsg.message?.text || '';

      // Extract Audio URL from Gallabox (whatsapp.audio.path)
      const audioUrl = newestCustomerMsg.whatsapp?.audio?.path
        || newestCustomerMsg.whatsapp?.audio?.link 
        || newestCustomerMsg.whatsapp?.audio?.url
        || newestCustomerMsg.whatsapp?.voice?.path
        || newestCustomerMsg.whatsapp?.voice?.link
        || newestCustomerMsg.whatsapp?.voice?.url
        || newestCustomerMsg.mediaUrl
        || newestCustomerMsg.media?.url
        || null;

      if (!msgText && audioUrl) {
        console.log(`\n[${new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}] 🎤 VOICE NOTE DETECTED from ${contact.name} (+91${cleanPhone})`);
        console.log(`Downloading audio from Gallabox: ${audioUrl}`);
        const audioBuffer = await downloadMediaBuffer(audioUrl);
        if (audioBuffer && audioBuffer.length > 0) {
          console.log(`Transcribing voice note with OpenAI Whisper... (${audioBuffer.length} bytes)`);
          const transcribedText = await transcribeVoiceNoteBuffer(audioBuffer);
          if (transcribedText && transcribedText.trim()) {
            msgText = `[Voice Note Transcribed]: ${transcribedText.trim()}`;
            console.log(`✨ Transcribed text: "${msgText}"`);
          } else {
            console.log('⚠️ Whisper transcription returned empty text.');
          }
        } else {
          console.log('⚠️ Failed to download audio buffer.');
        }
      }

      if (!msgText || msgText.trim() === '') continue;

      processedMessageIds.add(msgId);
      lastProcessedTimes.set(cleanPhone, Date.now());

      console.log(`\n[${new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}] 📩 NEW TESTER MESSAGE:`);
      console.log(`From: ${contact.name} (+91${cleanPhone})`);
      console.log(`Message Content: "${msgText}"`);

      const payload = JSON.stringify({
        event: 'message.received',
        contact: { phone: '+' + cleanPhone, name: contact.name },
        message: { text: msgText }
      });

      const req = https.request({
        hostname: CLOUD_N8N_HOST,
        path: '/webhook/renavkar-whatsapp',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          console.log(`⚡ Cloud n8n AI Triggered: [${res.statusCode}] ${body}`);
        });
      });
      req.on('error', (err) => console.error('Cloud n8n dispatch error:', err.message));
      req.write(payload);
      req.end();
    }
  } catch (err) {
    console.error('Polling cycle error:', err.message);
  }
}

async function main() {
  console.log(`=== Renavkar Real Estate — 24/7 Cloud Polling Daemon (Voice-Note Enabled) ===`);
  console.log(`Cloud n8n Host: ${CLOUD_N8N_HOST}`);
  console.log(`Whitelisted Testers: ${TEST_PHONES.join(', ')}`);

  const convs = await fetchGallabox(`/conversations?channelId=${channelId}&limit=15`);
  const items = Array.isArray(convs) ? convs : convs?.data || [];

  for (const conv of items) {
    if (!conv?.contactId) continue;
    const msgs = await fetchGallabox(`/messages?channelId=${channelId}&contactId=${conv.contactId}&limit=10`);
    const msgList = Array.isArray(msgs) ? msgs : msgs?.data || [];
    msgList.forEach(m => {
      if (m.sender === conv.contactId) {
        const ageMs = Date.now() - new Date(m.createdAt).getTime();
        if (ageMs > 120000) {
          const id = m.id || `${m.createdAt}_${m.whatsapp?.text?.body}`;
          processedMessageIds.add(id);
        }
      }
    });
  }

  console.log(`✅ Seeded ${processedMessageIds.size} historical message IDs.`);
  console.log(`🚀 24/7 Voice-Note Enabled Cloud Polling active every 3 seconds...\n`);

  setInterval(pollOnce, 3000);
}

main().catch(console.error);
