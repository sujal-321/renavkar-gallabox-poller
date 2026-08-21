'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MessageDebouncer } = require('./debouncer');
const { JsonStateStore } = require('./state_store');
const {
  getSystemPrompt,
  normalizeVisitDateTime,
  parseLeadAction
} = require('./ai_agent');

test('cross-day verification keeps a booked appointment date authoritative', () => {
  const prompt = getSystemPrompt({ preferred_visit_date: '21/08/2026, 05:00 PM', status: 'CONFIRMED' }, new Date('2026-08-21T04:00:00.000Z'));
  assert.match(prompt, /21\/08\/2026, 05:00 PM/);
  assert.match(prompt, /verified.*date|ground.*date/i);
});

test('reschedule tags carry the replacement appointment', () => {
  assert.equal(parseLeadAction('<lead_action type="RESCHEDULE">{"new_visit_date":"23/08/2026, 11:00 AM"}</lead_action>').type, 'RESCHEDULE');
  assert.equal(parseLeadAction('<lead_action type="RESCHEDULE">{"new_visit_date":"23/08/2026, 11:00 AM"}</lead_action>').data.new_visit_date, '23/08/2026, 11:00 AM');
});

test('cancellation tags carry a reason and do not become reschedules', () => {
  assert.equal(parseLeadAction('<lead_action type="CANCEL">{"reason":"busy"}</lead_action>').type, 'CANCEL');
  assert.equal(parseLeadAction('<lead_action type="CANCEL">{"reason":"busy"}</lead_action>').data.reason, 'busy');
});

test('colloquial appointment slots normalize deterministically', () => {
  const base = new Date('2026-08-20T12:00:00+05:30');
  assert.equal(normalizeVisitDateTime('tomorrow morning', base), '21/08/2026, 11:00 AM');
  assert.equal(normalizeVisitDateTime('tomorrow afternoon', base), '21/08/2026, 03:00 PM');
});

test('midnight window is explicitly exposed to the prompt', () => {
  assert.match(getSystemPrompt(null, new Date('2026-08-20T23:00:00.000Z')), /NIGHT_HOURS_ACTIVE: true/);
});

test('rapid bubbles remain one debounced conversation turn', async () => {
  const flushed = [];
  const debouncer = new MessageDebouncer({
    debounceMs: 10,
    onFlush: async payload => { flushed.push(payload); return { ok: true }; }
  });
  await Promise.all([
    debouncer.push('9014998200', { message_id: 'a', message_text: 'Sunday' }),
    debouncer.push('9014998200', { message_id: 'b', message_text: 'at 5' }),
    debouncer.push('9014998200', { message_id: 'c', message_text: 'actually 6 pm' })
  ]);
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].message_text, 'Sunday\nat 5\nactually 6 pm');
});

test('property pivots use structured requirement updates', () => {
  const action = parseLeadAction('<lead_action type="UPDATE_REQUIREMENT">{"requirement":"1BHK","budget":"74.88 Lakhs"}</lead_action>');
  assert.deepEqual(action.data, { requirement: '1BHK', budget: '74.88 Lakhs' });
});

test('language switching remains prompt-controlled', () => {
  const prompt = getSystemPrompt();
  assert.match(prompt, /HINDI \/ HINGLISH ONLY IF CUSTOMER INITIATES/);
});

test('durable message state can represent a human takeover pause', () => {
  const file = require('path').join(require('os').tmpdir(), `renavkar-edge-${process.pid}.json`);
  const store = new JsonStateStore(file);
  store.load();
  store.mark('human-lock', { status: 'paused', reason: 'human_takeover', expiresAt: Date.now() + 30 * 60 * 1000 });
  assert.equal(store.getMessage('human-lock').reason, 'human_takeover');
});

test('lead state remains durable when a Sheets action endpoint is unavailable', async () => {
  const { executeLeadAction } = require('./ai_agent');
  const { fetchLeadState, clearLeadStateCache } = require('./supabase_memory');
  clearLeadStateCache();
  const result = await executeLeadAction('919014998200', {
    type: 'CANCEL', data: { reason: 'No longer interested' }
  }, { googleSheetWebhookUrl: 'http://127.0.0.1:59998/exec' });
  assert.equal(result.state.status, 'CANCELLED');
  assert.equal((await fetchLeadState('919014998200')).status, 'CANCELLED');
});
