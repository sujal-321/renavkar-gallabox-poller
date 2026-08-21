'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

test('production config requires Supabase secrets from the environment', () => {
  const source = fs.readFileSync(require.resolve('./index'), 'utf8');
  assert.match(source, /supabaseKey:\s*process\.env\.SUPABASE_KEY\s*\|\|\s*process\.env\.SUPABASE_SERVICE_ROLE_KEY\s*\|\|\s*''/);
  assert.doesNotMatch(source, /supabaseKey:[^\n]*\|\|\s*'[A-Za-z0-9_-]{20,}'/);
});

test('Supabase migration protects history and defines retention', () => {
  const sql = fs.readFileSync(require.resolve('./supabase_schema.sql'), 'utf8');
  assert.match(sql, /alter table public\.chat_history enable row level security/i);
  assert.match(sql, /chat_history_phone_created_at_idx/i);
  assert.match(sql, /purge_old_chat_history/i);
  assert.match(sql, /retention_days integer default 90/i);
});
