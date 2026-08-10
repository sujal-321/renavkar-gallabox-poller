'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { KeyedSerialQueue } = require('./keyed_queue');
const { JsonStateStore } = require('./state_store');

test('serializes work for one phone but not unrelated phones', async () => {
  const queue = new KeyedSerialQueue();
  const events = [];
  const task = (name, delay) => queue.run('same-phone', async () => {
    events.push(`${name}:start`);
    await new Promise(resolve => setTimeout(resolve, delay));
    events.push(`${name}:end`);
  });

  await Promise.all([task('one', 20), task('two', 1)]);
  assert.deepEqual(events, ['one:start', 'one:end', 'two:start', 'two:end']);
});

test('persists message status atomically', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'renavkar-state-'));
  const file = path.join(directory, 'state.json');
  const first = new JsonStateStore(file);
  first.load();
  first.mark('message-1', { status: 'done' });

  const second = new JsonStateStore(file);
  second.load();
  assert.equal(second.getMessage('message-1').status, 'done');
});
