'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { appendLeadToGoogleSheet } = require('./sheets_logger');

test('appendLeadToGoogleSheet sends POST request to webhook', async () => {
  let receivedBody = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      receivedBody = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'success' }));
    });
  });

  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const webhookUrl = `http://localhost:${port}/exec`;

  const leadData = {
    lead_name: 'Test Buyer',
    phone: '9014998200',
    budget: '40 Lakhs',
    requirement: 'Studio'
  };

  const result = await appendLeadToGoogleSheet(webhookUrl, leadData);
  assert.equal(result.status, 'success');
  assert.equal(receivedBody.lead_name, 'Test Buyer');
  assert.equal(receivedBody.phone, '9014998200');

  await new Promise(resolve => server.close(resolve));
});

test('appendLeadToGoogleSheet forwards lifecycle action payloads', async () => {
  let receivedBody = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      receivedBody = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  await new Promise(resolve => server.listen(0, resolve));
  const webhookUrl = `http://127.0.0.1:${server.address().port}/exec`;
  await appendLeadToGoogleSheet(webhookUrl, {
    action: 'reschedule_appointment',
    phone: '9014998200',
    new_visit_date: '23/08/2026, 11:00 AM'
  });

  assert.equal(receivedBody.action, 'reschedule_appointment');
  assert.equal(receivedBody.new_visit_date, '23/08/2026, 11:00 AM');
  await new Promise(resolve => server.close(resolve));
});

test('appendLeadToGoogleSheet gracefully skips if no webhook url provided', async () => {
  const result = await appendLeadToGoogleSheet('', { lead_name: 'Nobody' });
  assert.equal(result.skipped, true);
});
