'use strict';

const https = require('https');

function appendLeadToGoogleSheet(webhookUrl, leadData) {
  return new Promise((resolve, reject) => {
    if (!webhookUrl) {
      return resolve({ skipped: true, reason: 'No webhook URL configured' });
    }

    const payload = JSON.stringify(leadData);
    const u = new URL(webhookUrl);

    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      // Google Apps Script redirects with 302 to googleusercontent.com
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        https.get(res.headers.location, redRes => {
          let body = '';
          redRes.on('data', c => body += c);
          redRes.on('end', () => {
            try {
              resolve(JSON.parse(body));
            } catch {
              resolve({ ok: true, raw: body });
            }
          });
        }).on('error', reject);
        return;
      }

      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve({ ok: true, raw: body });
          }
        } else {
          reject(new Error(`Google Apps Script HTTP ${res.statusCode}: ${body.slice(0, 150)}`));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

module.exports = { appendLeadToGoogleSheet };
