const https = require('https');

const accountId = '67a9c520769cafdc2619b890';
const apiKey = '6a6c3d954e9f17dacc3852c8';
const apiSecret = '59b1427962cc45be88a6fa600274ad84';
const channelId = '6810a60fc082cc5328b8f64f';

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

      const msgText = newestCustomerMsg.whatsapp?.text?.body || newestCustomerMsg.text?.body || newestCustomerMsg.message?.text || '';
      if (!msgText || msgText.trim() === '') continue;

      processedMessageIds.add(msgId);
      lastProcessedTimes.set(cleanPhone, Date.now());

      console.log(`\n[${new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}] 📩 NEW TESTER MESSAGE:`);
      console.log(`From: ${contact.name} (+91${cleanPhone})`);
      console.log(`Text: "${msgText}"`);

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
  console.log(`=== Renavkar Real Estate — 24/7 Cloud Polling Daemon ===`);
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
  console.log(`🚀 24/7 Cloud Polling active every 3 seconds...\n`);

  setInterval(pollOnce, 3000);
}

main().catch(console.error);
