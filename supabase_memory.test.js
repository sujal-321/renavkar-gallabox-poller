'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const {
  fetchSupabaseHistory,
  saveSupabaseMessage,
  getLocalHistory,
  addToLocalHistory,
  saveLeadState,
  fetchLeadState,
  clearLeadStateCache,
  formatISTTimestamp
} = require('./supabase_memory');

test('local memory retains last 12 messages and attaches formatted IST timestamps', () => {
  clearLeadStateCache();
  const phone = '919014998200_test';
  const ts = new Date('2026-08-20T20:51:00+05:30').getTime();
  
  addToLocalHistory(phone, 'user', 'Tommorow um like 5 pm?', ts);
  const history = getLocalHistory(phone);
  
  assert.equal(history.length, 1);
  assert.equal(history[0].role, 'user');
  assert.equal(history[0].content, 'Tommorow um like 5 pm?');
  assert.ok(history[0].formattedTimestamp.includes('20/08/2026'));
  assert.ok(history[0].formattedTimestamp.includes('08:51 PM IST'));

  for (let i = 2; i <= 15; i++) {
    addToLocalHistory(phone, i % 2 === 0 ? 'assistant' : 'user', `Message ${i}`);
  }
  const fullHistory = getLocalHistory(phone);
  assert.equal(fullHistory.length, 12);
  assert.equal(fullHistory[fullHistory.length - 1].content, 'Message 15');
});

test('saveLeadState and fetchLeadState store and retrieve active lead state from RAM cache', async () => {
  clearLeadStateCache();
  const phone = '9014998200';
  const state = {
    lead_name: 'Sujal Darla',
    requirement: '1BHK',
    budget: '75 Lakhs',
    preferred_payment_plan: 'Down Payment',
    site_visit_interest: 'Yes',
    preferred_visit_date: '21/08/2026, 05:00 PM',
    status: 'CONFIRMED'
  };

  const saveRes = await saveLeadState(phone, state);
  assert.equal(saveRes.ok, true);

  const fetched = await fetchLeadState(phone);
  assert.ok(fetched);
  assert.equal(fetched.lead_name, 'Sujal Darla');
  assert.equal(fetched.preferred_visit_date, '21/08/2026, 05:00 PM');
  assert.equal(fetched.requirement, '1BHK');
  assert.equal(fetched.status, 'CONFIRMED');
});

test('fetchSupabaseHistory falls back to local memory with timeout protection if server unreachable', async () => {
  clearLeadStateCache();
  const phone = '919014998200_fallback';
  addToLocalHistory(phone, 'user', 'Hello local');

  const history = await fetchSupabaseHistory(phone, {
    supabaseUrl: 'http://127.0.0.1:59999',
    supabaseKey: 'test-key'
  });

  assert.equal(history.length, 1);
  assert.equal(history[0].content, 'Hello local');
});

test('lead state falls back to the existing chat_history table when lead_state is unavailable', async () => {
  clearLeadStateCache();
  let stored = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      if (req.url.startsWith('/rest/v1/lead_state')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ message: "Could not find the table 'public.lead_state'" }));
      }
      if (req.url.startsWith('/rest/v1/chat_history') && req.method === 'POST') {
        stored = JSON.parse(body);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        return res.end('{}');
      }
      if (req.url.startsWith('/rest/v1/chat_history') && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(stored ? [stored] : []));
      }
      res.writeHead(404);
      res.end();
    });
  });

  await new Promise(resolve => server.listen(0, resolve));
  const config = { supabaseUrl: `http://127.0.0.1:${server.address().port}`, supabaseKey: 'test-key' };
  const state = { lead_name: 'Sujal Darla', preferred_visit_date: '21/08/2026, 05:00 PM', status: 'CONFIRMED' };

  const saved = await saveLeadState('9014998200', state, config);
  assert.equal(saved.ok, true);
  assert.equal(saved.fallback, 'chat_history');

  clearLeadStateCache();
  const fetched = await fetchLeadState('9014998200', config);
  assert.equal(fetched.lead_name, 'Sujal Darla');
  assert.equal(fetched.status, 'CONFIRMED');

  await new Promise(resolve => server.close(resolve));
});

test('fetchSupabaseHistory caps remote history and excludes internal lead-state snapshots', async () => {
  clearLeadStateCache();
  let requestedUrl = '';
  const server = http.createServer((req, res) => {
    requestedUrl = req.url;
    const rows = Array.from({ length: 15 }, (_, index) => ({
      role: index === 0 ? 'assistant' : 'user',
      content: index === 0 ? '[RENAVKAR_LEAD_STATE] {"status":"CONFIRMED"}' : `Message ${index}`,
      created_at: new Date(2026, 7, 20, 10, index).toISOString()
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(rows));
  });

  await new Promise(resolve => server.listen(0, resolve));
  const history = await fetchSupabaseHistory('9014998200_bounded', {
    supabaseUrl: `http://127.0.0.1:${server.address().port}`,
    supabaseKey: 'test-key'
  }, 99);

  assert.match(requestedUrl, /limit=12/);
  assert.equal(history.length, 12);
  assert.equal(history.some(item => item.content.startsWith('[RENAVKAR_LEAD_STATE]')), false);
  await new Promise(resolve => server.close(resolve));
});
