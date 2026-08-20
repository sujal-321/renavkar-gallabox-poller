'use strict';

const https = require('https');

const keepAliveAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 30,
  keepAliveMsecs: 30000
});

const localHistory = new Map();

function getLocalHistory(phone) {
  const cleanPhone = String(phone || '').replace(/[^0-9]/g, '');
  if (!localHistory.has(cleanPhone)) localHistory.set(cleanPhone, []);
  return localHistory.get(cleanPhone);
}

function addToLocalHistory(phone, role, content) {
  const cleanPhone = String(phone || '').replace(/[^0-9]/g, '');
  const history = getLocalHistory(cleanPhone);
  history.push({ role, content, timestamp: Date.now() });
  while (history.length > 12) history.shift();
}

function fetchSupabaseHistory(phone, config, limit = 12) {
  const cleanPhone = String(phone || '').replace(/[^0-9]/g, '');

  // Fast path: if RAM memory has conversation history, return immediately (0ms latency)
  const cached = localHistory.get(cleanPhone);
  if (cached && cached.length > 0) {
    return Promise.resolve(cached.map(r => ({ role: r.role, content: r.content })));
  }

  return new Promise((resolve) => {
    const supabaseUrl = config?.supabaseUrl || process.env.SUPABASE_URL;
    const supabaseKey = config?.supabaseKey || process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return resolve(getLocalHistory(cleanPhone));
    }

    const u = new URL(`${supabaseUrl}/rest/v1/chat_history?phone=eq.${cleanPhone}&order=created_at.desc&limit=${limit}`);

    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      agent: keepAliveAgent,
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
            if (Array.isArray(rows) && rows.length > 0) {
              const chronological = rows.reverse().map(r => ({
                role: r.role,
                content: r.content
              }));
              // Populate RAM cache
              localHistory.set(cleanPhone, chronological);
              return resolve(chronological);
            }
          } catch (e) {}
        }
        resolve(getLocalHistory(cleanPhone));
      });
    });

    req.on('error', () => resolve(getLocalHistory(cleanPhone)));
    req.end();
  });
}

function saveSupabaseMessage(phone, role, content, config) {
  const cleanPhone = String(phone || '').replace(/[^0-9]/g, '');
  // Always update local memory first (instant)
  addToLocalHistory(cleanPhone, role, content);

  const supabaseUrl = config?.supabaseUrl || process.env.SUPABASE_URL;
  const supabaseKey = config?.supabaseKey || process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) return Promise.resolve({ ok: true, skipped: true });

  // Non-blocking async background save
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
      agent: keepAliveAgent,
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
  addToLocalHistory,
  keepAliveAgent
};

