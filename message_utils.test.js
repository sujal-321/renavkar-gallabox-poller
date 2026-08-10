'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractButton,
  extractText,
  getMessageId,
  normalizeMessage
} = require('./message_utils');

test('extracts text and stable message id', () => {
  const message = {
    id: 'msg-1',
    createdAt: '2026-08-10T10:00:00.000Z',
    whatsapp: { text: { body: 'What is the studio price?' } }
  };
  assert.equal(extractText(message), 'What is the studio price?');
  assert.equal(getMessageId(message, 'contact-1'), 'msg-1');
});

test('extracts quick-reply payload and title', () => {
  const message = {
    id: 'button-1',
    whatsapp: { interactive: { button_reply: { id: 'schedule_call', title: "Let's get on a call" } } }
  };
  assert.deepEqual(extractButton(message), { payload: 'schedule_call', text: "Let's get on a call" });
  assert.equal(extractText(message), 'schedule_call');
});

test('normalizes a transcribed voice note', () => {
  const message = {
    id: 'voice-1',
    createdAt: '2026-08-10T10:00:00.000Z',
    whatsapp: { audio: { path: 'https://files.example/voice.oga' } }
  };
  const normalized = normalizeMessage(message, {
    contactId: 'contact-1',
    contact: { name: 'Arihant', phone: ['+919999999999'] },
    transcription: 'Please share the brochure'
  });
  assert.equal(normalized.voice_note_status, 'transcribed');
  assert.match(normalized.message_text, /Please share the brochure/);
  assert.equal(normalized.sender_phone, '919999999999');
});

test('keeps a failed voice note actionable', () => {
  const normalized = normalizeMessage({ id: 'voice-2', whatsapp: { audio: { url: 'https://files.example/voice.ogg' } } }, {
    contactId: 'contact-2',
    contact: { phone: '+911111111111' },
    transcriptionError: new Error('failed')
  });
  assert.equal(normalized.voice_note_status, 'failed');
  assert.match(normalized.message_text, /could not be transcribed/);
});
