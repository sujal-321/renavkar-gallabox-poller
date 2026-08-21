'use strict';

const http = require('http');
const https = require('https');

const keepAliveAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 30,
  keepAliveMsecs: 30000
});

const keepAliveHttpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 30,
  keepAliveMsecs: 30000
});

const localHistory = new Map();
const localLeadState = new Map();
const LEAD_STATE_HISTORY_PREFIX = '[RENAVKAR_LEAD_STATE] ';

function supabaseConfig(config) {
  return {
    url: config?.supabaseUrl || process.env.SUPABASE_URL || '',
    key: config?.supabaseKey || process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  };
}

function persistLeadStateInChatHistory(cleanPhone, updatedState, config) {
  const { url, key } = supabaseConfig(config);
  if (!url || !key) return Promise.resolve({ ok: false, state: updatedState, fallback: 'memory' });

  return new Promise(resolve => {
    try {
      const u = new URL(`${url}/rest/v1/chat_history`);
      const payload = JSON.stringify({
        phone: cleanPhone,
        role: 'assistant',
        content: `${LEAD_STATE_HISTORY_PREFIX}${JSON.stringify(updatedState)}`
      });
      const client = u.protocol === 'http:' ? http : https;
      const agent = u.protocol === 'http:' ? keepAliveHttpAgent : keepAliveAgent;
      const req = client.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname,
        method: 'POST',
        agent,
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, res => {
        res.resume();
        res.on('end', () => resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          state: updatedState,
          fallback: 'chat_history'
        }));
      });
      req.setTimeout(2500, () => { req.destroy(); resolve({ ok: false, state: updatedState, fallback: 'memory' }); });
      req.on('error', () => resolve({ ok: false, state: updatedState, fallback: 'memory' }));
      req.write(payload);
      req.end();
    } catch {
      resolve({ ok: false, state: updatedState, fallback: 'memory' });
    }
  });
}

function fetchLeadStateFromChatHistory(cleanPhone, config) {
  const { url, key } = supabaseConfig(config);
  if (!url || !key) return Promise.resolve(null);

  return new Promise(resolve => {
    try {
      const u = new URL(`${url}/rest/v1/chat_history?phone=eq.${cleanPhone}&role=eq.assistant&order=created_at.desc&limit=50`);
      const client = u.protocol === 'http:' ? http : https;
      const agent = u.protocol === 'http:' ? keepAliveHttpAgent : keepAliveAgent;
      const req = client.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search,
        method: 'GET',
        agent,
        headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' }
      }, res => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return resolve(null);
          try {
            const rows = JSON.parse(body);
            const row = (Array.isArray(rows) ? rows : []).find(item => String(item.content || '').startsWith(LEAD_STATE_HISTORY_PREFIX));
            if (!row) return resolve(null);
            const state = JSON.parse(String(row.content).slice(LEAD_STATE_HISTORY_PREFIX.length));
            localLeadState.set(cleanPhone, state);
            resolve(state);
          } catch {
            resolve(null);
          }
        });
      });
      req.setTimeout(2500, () => { req.destroy(); resolve(null); });
      req.on('error', () => resolve(null));
      req.end();
    } catch {
      resolve(null);
    }
  });
}

function formatISTTimestamp(ts = Date.now()) {
  const d = new Date(ts);
  const nowIST = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = String(nowIST.getDate()).padStart(2, '0');
  const month = String(nowIST.getMonth() + 1).padStart(2, '0');
  const year = nowIST.getFullYear();
  let h = nowIST.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  const strH = String(h).padStart(2, '0');
  const strM = String(nowIST.getMinutes()).padStart(2, '0');
  return `${day}/${month}/${year}, ${strH}:${strM} ${ampm} IST`;
}

function getLocalHistory(phone) {
  const cleanPhone = String(phone || '').replace(/[^0-9]/g, '');
  if (!localHistory.has(cleanPhone)) localHistory.set(cleanPhone, []);
  return localHistory.get(cleanPhone);
}

function addToLocalHistory(phone, role, content, timestamp = Date.now()) {
  const cleanPhone = String(phone || '').replace(/[^0-9]/g, '');
  const history = getLocalHistory(cleanPhone);
  const formattedTimestamp = formatISTTimestamp(timestamp);
  history.push({
    role,
    content,
    timestamp,
    formattedTimestamp
  });
  while (history.length > 12) history.shift();
}

function saveLeadState(phone, state, config) {
  const cleanPhone = String(phone || '').replace(/[^0-9]/g, '').slice(-10);
  if (!cleanPhone) return Promise.resolve({ ok: false, error: 'Invalid phone' });

  const existing = localLeadState.get(cleanPhone) || {};
  const updatedState = {
    ...existing,
    ...state,
    phone: cleanPhone,
    last_updated_at: new Date().toISOString()
  };

  localLeadState.set(cleanPhone, updatedState);

  const { url: supabaseUrl, key: supabaseKey } = supabaseConfig(config);

  if (!supabaseUrl || !supabaseKey) {
    return Promise.resolve({ ok: true, state: updatedState, cached: true });
  }

  return new Promise((resolve) => {
    try {
      const u = new URL(`${supabaseUrl}/rest/v1/lead_state`);
      const payload = JSON.stringify({
        phone: cleanPhone,
        lead_name: updatedState.lead_name || 'Valued Investor',
        requirement: updatedState.requirement || 'Studio/1BHK',
        budget: updatedState.budget || 'N/A',
        preferred_payment_plan: updatedState.preferred_payment_plan || 'Not specified',
        site_visit_interest: updatedState.site_visit_interest || 'Yes',
        preferred_visit_date: updatedState.preferred_visit_date || '',
        status: updatedState.status || 'QUALIFIED',
        updated_at: new Date().toISOString()
      });

      const client = u.protocol === 'http:' ? http : https;
      const agent = u.protocol === 'http:' ? keepAliveHttpAgent : keepAliveAgent;

      const req = client.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname,
        method: 'POST',
        agent,
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates,return=minimal',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, res => {
        if (res.statusCode === 404) {
          res.resume();
          return res.on('end', async () => resolve(await persistLeadStateInChatHistory(cleanPhone, updatedState, config)));
        }
        res.resume();
        res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, state: updatedState }));
      });

      req.setTimeout(2500, () => {
        req.destroy();
        resolve({ ok: true, state: updatedState, fallback: 'timeout' });
      });

      req.on('error', err => {
        resolve({ ok: true, state: updatedState, fallback: err.message });
      });

      req.write(payload);
      req.end();
    } catch (err) {
      resolve({ ok: true, state: updatedState, fallback: err.message });
    }
  });
}

function fetchLeadState(phone, config) {
  const cleanPhone = String(phone || '').replace(/[^0-9]/g, '').slice(-10);
  if (!cleanPhone) return Promise.resolve(null);

  const cached = localLeadState.get(cleanPhone);
  if (cached) return Promise.resolve(cached);

  const { url: supabaseUrl, key: supabaseKey } = supabaseConfig(config);

  if (!supabaseUrl || !supabaseKey) return Promise.resolve(null);

  return new Promise((resolve) => {
    try {
      const u = new URL(`${supabaseUrl}/rest/v1/lead_state?phone=eq.${cleanPhone}&limit=1`);
      const client = u.protocol === 'http:' ? http : https;
      const agent = u.protocol === 'http:' ? keepAliveHttpAgent : keepAliveAgent;

      const req = client.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search,
        method: 'GET',
        agent,
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
                localLeadState.set(cleanPhone, rows[0]);
                return resolve(rows[0]);
              }
            } catch {}
          }
          fetchLeadStateFromChatHistory(cleanPhone, config).then(resolve);
        });
      });

      req.setTimeout(2500, () => {
        req.destroy();
        resolve(null);
      });

      req.on('error', () => resolve(null));
      req.end();
    } catch {
      resolve(null);
    }
  });
}

function clearLeadStateCache(phone) {
  if (phone) {
    const cleanPhone = String(phone).replace(/[^0-9]/g, '').slice(-10);
    localLeadState.delete(cleanPhone);
    localHistory.delete(cleanPhone);
  } else {
    localLeadState.clear();
    localHistory.clear();
  }
}

function fetchSupabaseHistory(phone, config, limit = 12) {
  const cleanPhone = String(phone || '').replace(/[^0-9]/g, '');
  const requestedLimit = Number(limit);
  const safeLimit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.floor(requestedLimit), 1), 12)
    : 12;

  // Fast path: if RAM memory has conversation history, return immediately (0ms latency)
  const cached = localHistory.get(cleanPhone);
  if (cached && cached.length > 0) {
    return Promise.resolve(cached.slice(-safeLimit).map(r => ({
      role: r.role,
      content: r.content,
      timestamp: r.timestamp || Date.now(),
      formattedTimestamp: r.formattedTimestamp || formatISTTimestamp(r.timestamp)
    })));
  }

  return new Promise((resolve) => {
    const supabaseUrl = config?.supabaseUrl || process.env.SUPABASE_URL;
    const supabaseKey = config?.supabaseKey || process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return resolve(getLocalHistory(cleanPhone));
    }

    try {
      const u = new URL(`${supabaseUrl}/rest/v1/chat_history?phone=eq.${cleanPhone}&role=in.(user,assistant)&order=created_at.desc&limit=${safeLimit}`);
      const client = u.protocol === 'http:' ? http : https;
      const agent = u.protocol === 'http:' ? keepAliveHttpAgent : keepAliveAgent;

      const req = client.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search,
        method: 'GET',
        agent,
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
                const chronological = rows.reverse().filter(r => (
                  (r.role === 'user' || r.role === 'assistant') &&
                  !String(r.content || '').startsWith(LEAD_STATE_HISTORY_PREFIX)
                )).map(r => {
                  const ts = r.created_at ? new Date(r.created_at).getTime() : Date.now();
                  return {
                    role: r.role,
                    content: r.content,
                    timestamp: ts,
                    formattedTimestamp: formatISTTimestamp(ts)
                  };
                });
                // Populate RAM cache
                localHistory.set(cleanPhone, chronological.slice(-12));
                return resolve(chronological.slice(-safeLimit));
              }
            } catch (e) {}
          }
          resolve(getLocalHistory(cleanPhone));
        });
      });

      req.setTimeout(2500, () => {
        req.destroy();
        resolve(getLocalHistory(cleanPhone));
      });

      req.on('error', () => resolve(getLocalHistory(cleanPhone)));
      req.end();
    } catch {
      resolve(getLocalHistory(cleanPhone));
    }
  });
}

function saveSupabaseMessage(phone, role, content, config, timestamp = Date.now()) {
  const cleanPhone = String(phone || '').replace(/[^0-9]/g, '');
  // Always update local memory first (instant)
  addToLocalHistory(cleanPhone, role, content, timestamp);

  const supabaseUrl = config?.supabaseUrl || process.env.SUPABASE_URL;
  const supabaseKey = config?.supabaseKey || process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) return Promise.resolve({ ok: true, skipped: true });

  // Non-blocking async background save
  return new Promise((resolve) => {
    try {
      const payload = JSON.stringify({
        phone: cleanPhone,
        role,
        content: String(content || '').slice(0, 4000)
      });

      const u = new URL(`${supabaseUrl}/rest/v1/chat_history`);
      const client = u.protocol === 'http:' ? http : https;
      const agent = u.protocol === 'http:' ? keepAliveHttpAgent : keepAliveAgent;

      const req = client.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname,
        method: 'POST',
        agent,
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

      req.setTimeout(2500, () => {
        req.destroy();
        resolve({ ok: true, fallback: 'timeout' });
      });

      req.on('error', err => {
        console.warn(`[Supabase Memory] Background save skipped: ${err.message}`);
        resolve({ ok: false, error: err.message });
      });

      req.write(payload);
      req.end();
    } catch (err) {
      resolve({ ok: false, error: err.message });
    }
  });
}

module.exports = {
  fetchSupabaseHistory,
  saveSupabaseMessage,
  getLocalHistory,
  addToLocalHistory,
  saveLeadState,
  fetchLeadState,
  clearLeadStateCache,
  formatISTTimestamp,
  keepAliveAgent
};
