'use strict';

const http = require('http');
const https = require('https');

function fetchJsonWithRedirect(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const client = u.protocol === 'http:' ? http : https;
    const req = client.get(u, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJsonWithRedirect(res.headers.location).then(resolve).catch(reject);
      }
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        try {
          resolve(JSON.parse(b));
        } catch (e) {
          resolve({ raw: b });
        }
      });
    });
    req.setTimeout(3000, () => req.destroy(new Error('Outbound request timed out after 3000ms')));
    req.on('error', reject);
  });
}

function sendOutboundTemplate({ accountId, apiKey, apiSecret, channelId, phone, name }) {
  return new Promise((resolve, reject) => {
    const cleanPhone = String(phone).replace(/[^0-9]/g, '');
    const cleanName = String(name || 'Valued Investor').trim();
    const payload = JSON.stringify({
      channelId,
      channelType: 'whatsapp',
      recipient: {
        name: cleanName,
        phone: cleanPhone
      },
      whatsapp: {
        type: 'template',
        template: {
          templateName: 'renavkar_welcome_lead_2',
          bodyValues: {
            '1': cleanName
          }
        }
      }
    });

    const req = https.request({
      hostname: 'server.gallabox.com',
      path: `/devapi/accounts/${accountId}/messages/whatsapp`,
      method: 'POST',
      headers: {
        'apiKey': apiKey,
        'apiSecret': apiSecret,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ ok: true, status: res.statusCode, body: b });
        } else {
          reject(new Error(`Gallabox HTTP ${res.statusCode}: ${b}`));
        }
      });
    });

    req.setTimeout(5000, () => req.destroy(new Error('Gallabox outbound request timed out after 5000ms')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function processUncontactedLeads(config) {
  if (!config.googleSheetWebhookUrl) return;

  try {
    const uncontactedUrl = `${config.googleSheetWebhookUrl}?action=get_uncontacted`;
    const leads = await fetchJsonWithRedirect(uncontactedUrl);

    if (!Array.isArray(leads) || leads.length === 0) return;

    for (const lead of leads) {
      const phone = String(lead.phone || '').replace(/[^0-9]/g, '');
      if (!phone) continue;

      // Whitelist check
      const last10 = phone.length >= 10 ? phone.slice(-10) : phone;
      const isAllowed = config.allowed.allowAll || config.allowed.phones.some(allowed => {
        const allowedClean = String(allowed).replace(/[^0-9]/g, '');
        const allowedLast10 = allowedClean.length >= 10 ? allowedClean.slice(-10) : allowedClean;
        return phone === allowedClean || phone.includes(allowedClean) || last10 === allowedLast10;
      });
      if (!isAllowed) {
        continue;
      }

      console.log(`🚀 [Outbound] Sending welcome template to ${lead.name} (+${phone})...`);
      try {
        await sendOutboundTemplate({
          accountId: config.accountId,
          apiKey: config.apiKey,
          apiSecret: config.apiSecret,
          channelId: config.channelId,
          phone,
          name: lead.name
        });

        // Mark contacted in sheet
        const markUrl = `${config.googleSheetWebhookUrl}?action=mark_contacted&row=${lead.row_index}`;
        await fetchJsonWithRedirect(markUrl);
        console.log(`✅ [Outbound] Template delivered & sheet updated for ${lead.name} (row ${lead.row_index})`);
      } catch (err) {
        console.error(`❌ [Outbound] Failed for ${lead.name} (+${phone}): ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`[Outbound Check Error]: ${err.message}`);
  }
}

module.exports = {
  fetchJsonWithRedirect,
  sendOutboundTemplate,
  processUncontactedLeads
};
