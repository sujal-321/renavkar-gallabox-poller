'use strict';

const https = require('https');

function appendLeadToGoogleSheet(webhookUrl, leadData) {
  return new Promise((resolve, reject) => {
    if (!webhookUrl) {
      return resolve({ skipped: true, reason: 'No webhook URL configured' });
    }

    const payload = JSON.stringify(leadData);
    const u = new URL(webhookUrl);

    function makePost(targetUrl, redirectsRemaining = 5) {
      if (redirectsRemaining <= 0) {
        return reject(new Error('Too many redirects in Google Sheets webhook'));
      }

      const parsedUrl = new URL(targetUrl);
      const req = https.request({
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, res => {
        // Google Apps Script redirects with 302 to googleusercontent.com
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectTarget = new URL(res.headers.location, targetUrl).href;
          return makePost(redirectTarget, redirectsRemaining - 1);
        }

        let body = '';
        res.on('data', chunk => body += chunk);
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
    }

    makePost(webhookUrl);
  });
}

module.exports = { appendLeadToGoogleSheet };
