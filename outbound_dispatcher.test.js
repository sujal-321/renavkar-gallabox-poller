'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { processUncontactedLeads, fetchJsonWithRedirect } = require('./outbound_dispatcher');

test('fetchJsonWithRedirect parses json response', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([{ id: 1, name: 'Lead 1' }]));
  });

  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const url = `http://localhost:${port}/exec?action=get_uncontacted`;

  const result = await fetchJsonWithRedirect(url);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Lead 1');

  await new Promise(resolve => server.close(resolve));
});

test('processUncontactedLeads skips unwhitelisted phones', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([{ row_index: 2, name: 'Random Person', phone: '9999999999' }]));
  });

  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;

  const config = {
    googleSheetWebhookUrl: `http://localhost:${port}/exec`,
    allowed: { allowAll: false, phones: ['9014998200', '9714991000'] }
  };

  // Should skip 9999999999 without error
  await processUncontactedLeads(config);

  await new Promise(resolve => server.close(resolve));
});
