'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { sendDiscordAlert } = require('./discord_alerter');

test('sendDiscordAlert sends formatted embed to webhook', async () => {
  let received = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      received = JSON.parse(body);
      res.writeHead(204);
      res.end();
    });
  });

  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const webhookUrl = `http://localhost:${port}/webhook`;

  const result = await sendDiscordAlert({
    webhookUrl,
    title: 'Test Alert',
    description: 'Unit test alert body',
    error: 'Test error message',
    phone: '9014998200',
    level: 'error'
  });

  assert.equal(result.ok, true);
  assert.equal(received.embeds[0].title, 'Test Alert');
  assert.equal(received.embeds[0].color, 15548997); // Red for error
  assert.equal(received.embeds[0].fields.some(f => f.name === 'Phone' && f.value === '+9014998200'), true);

  await new Promise(resolve => server.close(resolve));
});

test('sendDiscordAlert skips gracefully if webhookUrl is empty', async () => {
  const result = await sendDiscordAlert({ webhookUrl: '', title: 'Test' });
  assert.equal(result.skipped, true);
});
