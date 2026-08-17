'use strict';

const https = require('https');

const localHistory = new Map();

function getLocalHistory(phone) {
  if (!localHistory.has(phone)) localHistory.set(phone, []);
  return localHistory.get(phone);
}

function addToLocalHistory(phone, role, content) {
  const history = getLocalHistory(phone);
  history.push({ role, content, timestamp: Date.now() });
  while (history.length > 12) history.shift();
}

function fetchSupabaseHistory(phone, config, limit = 12) {
  return new Promise((resolve) => {
    const supabaseUrl = config.supabaseUrl || process.env.SUPABASE_URL;
    const supabaseKey = config.supabaseKey || process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return resolve(getLocalHistory(phone));
    }

    const cleanPhone = String(phone).replace(/[^0-9]/g, '');
    const u = new URL(`${supabaseUrl}/rest/v1/chat_history?phone=eq.${cleanPhone}&order=created_at.desc&limit=${limit}`);

    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Accept': 'application/json'
      }
    }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const rows = JSON.parse(body);
            if (Array.isArray(rows)) {
              // Rows come in desc order, reverse to chronological
              const chronological = rows.reverse().map(r => ({
                role: r.role,
                content: r.content
              }));
              return resolve(chronological);
            }
          } catch (e) {}
        }
        // Fallback to local memory if table missing or error
        resolve(getLocalHistory(phone));
      });
    });

    req.on('error', () => resolve(getLocalHistory(phone)));
    req.end();
  });
}

function saveSupabaseMessage(phone, role, content, config) {
  const cleanPhone = String(phone).replace(/[^0-9]/g, '');
  // Always update local memory first
  addToLocalHistory(cleanPhone, role, content);

  const supabaseUrl = config.supabaseUrl || process.env.SUPABASE_URL;
  const supabaseKey = config.supabaseKey || process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) return Promise.resolve();

  return new Promise((resolve) => {
    const payload = JSON.stringify({
      phone: cleanPhone,
      role,
      content: String(content || '').slice(0, 4000)
    });

    const u = new URL(`${supabaseUrl}/rest/v1/chat_history`);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode });
    });

    req.on('error', err => {
      console.warn(`[Supabase Memory] Background save skipped: ${err.message}`);
      resolve({ ok: false, error: err.message });
    });

    req.write(payload);
    req.end();
  });
}

module.exports = {
  fetchSupabaseHistory,
  saveSupabaseMessage,
  getLocalHistory,
  addToLocalHistory
};
