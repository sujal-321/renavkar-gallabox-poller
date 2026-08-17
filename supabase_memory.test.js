'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { fetchSupabaseHistory, saveSupabaseMessage, getLocalHistory, addToLocalHistory } = require('./supabase_memory');

test('local memory retains last 12 messages', () => {
  const phone = '919014998200_test';
  for (let i = 1; i <= 15; i++) {
    addToLocalHistory(phone, i % 2 === 0 ? 'assistant' : 'user', `Message ${i}`);
  }
  const history = getLocalHistory(phone);
  assert.equal(history.length, 12);
  assert.equal(history[history.length - 1].content, 'Message 15');
});

test('fetchSupabaseHistory falls back to local memory if server unreachable', async () => {
  const phone = '919014998200_fallback';
  addToLocalHistory(phone, 'user', 'Hello local');

  const history = await fetchSupabaseHistory(phone, {
    supabaseUrl: 'http://localhost:59999',
    supabaseKey: 'test-key'
  });

  assert.equal(history.length, 1);
  assert.equal(history[0].content, 'Hello local');
});
