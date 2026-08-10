'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPoller, parseDispatchAck } = require('./index');
const { JsonStateStore } = require('./state_store');

test('poller dispatches every new inbound message in order', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'renavkar-poller-'));
  const store = new JsonStateStore(path.join(directory, 'state.json'));
  store.load();

  const dispatched = [];
  const messages = [
    { id: 'msg-1', sender: 'contact-1', createdAt: new Date().toISOString(), whatsapp: { text: { body: 'What is the price?' } } },
    { id: 'msg-2', sender: 'contact-1', createdAt: new Date(Date.now() + 1).toISOString(), whatsapp: { text: { body: 'Can I schedule a visit?' } } }
  ];

  const fetchMock = async requestPath => {
    if (requestPath.startsWith('/conversations')) return { data: [{ id: 'conversation-1', contactId: 'contact-1' }] };
    if (requestPath.startsWith('/contacts/')) return { name: 'Test Investor', phone: ['+919014998200'] };
    if (requestPath.startsWith('/messages')) return { data: messages };
    throw new Error(`Unexpected request: ${requestPath}`);
  };

  const poller = createPoller({
    fetch: fetchMock,
    store,
    dispatch: async payload => {
      dispatched.push(payload.message_id);
      await new Promise(resolve => setTimeout(resolve, 2));
    }
  });

  await poller.pollOnce();
  assert.deepEqual(dispatched, ['msg-1', 'msg-2']);
  assert.equal(store.getMessage('msg-1').status, 'done');
  assert.equal(store.getMessage('msg-2').status, 'done');
});

test('accepts only an explicit matching n8n delivery acknowledgement', () => {
  assert.deepEqual(
    parseDispatchAck(JSON.stringify({ ok: true, message_id: 'msg-1', reply_sent: true }), 'msg-1'),
    { ok: true, message_id: 'msg-1', reply_sent: true }
  );
  assert.throws(() => parseDispatchAck('', 'msg-1'), /non-JSON acknowledgement/);
  assert.throws(() => parseDispatchAck(JSON.stringify({ ok: false, message_id: 'msg-1' }), 'msg-1'), /did not confirm/);
  assert.throws(() => parseDispatchAck(JSON.stringify({ ok: true, message_id: 'msg-2' }), 'msg-1'), /message mismatch/);
});
