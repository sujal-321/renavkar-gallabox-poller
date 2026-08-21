'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MessageDebouncer } = require('./debouncer');

test('debouncer dispatches single message after delay', async () => {
  const dispatched = [];
  const debouncer = new MessageDebouncer({
    debounceMs: 25,
    onFlush: async (payload, contact, ids) => {
      dispatched.push({ payload, contact, ids });
      return { ok: true, message_id: payload.message_id };
    }
  });

  const res = await debouncer.push('919014998200', { message_id: 'm1', message_text: 'What are you?' }, { name: 'Sujal' });
  assert.equal(res.ok, true);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].payload.message_text, 'What are you?');
  assert.deepEqual(dispatched[0].ids, ['m1']);
});

test('debouncer bundles rapid multi-bubble messages into a single dispatch', async () => {
  const dispatched = [];
  const debouncer = new MessageDebouncer({
    debounceMs: 30,
    onFlush: async (payload, contact, ids) => {
      dispatched.push({ payload, contact, ids });
      return { ok: true, message_id: payload.message_id };
    }
  });

  const p1 = debouncer.push('919014998200', { message_id: 'm1', message_text: 'What are you?' }, { name: 'Sujal' });
  await new Promise(r => setTimeout(r, 10));
  const p2 = debouncer.push('919014998200', { message_id: 'm2', message_text: 'A bot?' }, { name: 'Sujal' });
  await new Promise(r => setTimeout(r, 10));
  const p3 = debouncer.push('919014998200', { message_id: 'm3', message_text: 'Or real estate agent?' }, { name: 'Sujal' });

  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(r3.ok, true);

  // Must only be dispatched ONCE
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].payload.message_text, 'What are you?\nA bot?\nOr real estate agent?');
  assert.deepEqual(dispatched[0].ids, ['m1', 'm2', 'm3']);
});

test('debouncer keeps different phones separate and independent', async () => {
  const dispatched = [];
  const debouncer = new MessageDebouncer({
    debounceMs: 25,
    onFlush: async (payload, contact, ids) => {
      dispatched.push({ phone: payload.sender_phone, text: payload.message_text });
      return { ok: true };
    }
  });

  const p1 = debouncer.push('919014998200', { message_id: 'm1', sender_phone: '919014998200', message_text: 'Hello from Sujal' });
  const p2 = debouncer.push('919714991000', { message_id: 'm2', sender_phone: '919714991000', message_text: 'Hello from Arihant' });

  await Promise.all([p1, p2]);
  assert.equal(dispatched.length, 2);
  assert.equal(dispatched.some(d => d.phone === '919014998200' && d.text === 'Hello from Sujal'), true);
  assert.equal(dispatched.some(d => d.phone === '919714991000' && d.text === 'Hello from Arihant'), true);
});

test('calculateAdaptiveDelay gives 0ms for buttons, 1200ms for questions, 1800ms for greetings', () => {
  const { calculateAdaptiveDelay } = require('./debouncer');

  // Button clicks -> 0ms
  assert.equal(calculateAdaptiveDelay({ button_payload: 'schedule_call' }), 0);
  assert.equal(calculateAdaptiveDelay({ button_text: 'Interested' }), 0);

  // Transcribed voice notes -> 500ms
  assert.equal(calculateAdaptiveDelay({ voice_note_status: 'transcribed', message_text: 'What is the price?' }), 500);

  // Questions -> 1200ms
  assert.equal(calculateAdaptiveDelay({ message_text: 'What is the price of 1BHK?' }), 1200);
  assert.equal(calculateAdaptiveDelay({ message_text: 'Where is the project located exactly in Ahmedabad?' }), 1200);

  // Short greeting -> 1800ms
  assert.equal(calculateAdaptiveDelay({ message_text: 'hi' }), 1800);
  assert.equal(calculateAdaptiveDelay({ message_text: 'hello' }), 1800);
});

test('debouncer dispatches button click immediately in adaptive mode', async () => {
  const dispatched = [];
  const debouncer = new MessageDebouncer({
    onFlush: async (payload) => {
      dispatched.push(payload);
      return { ok: true };
    }
  });

  const t0 = Date.now();
  const res = await debouncer.push('919014998200', {
    message_id: 'btn-1',
    button_payload: 'schedule_call',
    message_text: 'schedule_call'
  }, { name: 'Sujal' });

  const elapsed = Date.now() - t0;
  assert.equal(res.ok, true);
  assert.equal(dispatched.length, 1);
  assert.ok(elapsed < 100, `Button dispatch should be immediate (<100ms), took ${elapsed}ms`);
});

test('debouncer can cancel one phone when a human agent takes over', async () => {
  let dispatched = 0;
  const debouncer = new MessageDebouncer({
    debounceMs: 50,
    onFlush: async () => { dispatched += 1; return { ok: true }; }
  });

  const pending = debouncer.push('919014998200', { message_id: 'human-1', message_text: 'Sunday' });
  const cleared = debouncer.clearPhone('919014998200');
  const result = await pending;

  assert.equal(cleared, true);
  assert.equal(result.paused, true);
  assert.equal(dispatched, 0);
  assert.equal(debouncer.isPending('919014998200'), false);
});
