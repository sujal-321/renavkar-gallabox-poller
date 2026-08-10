'use strict';

const crypto = require('crypto');

function cleanPhone(value) {
  return String(value || '').replace(/[^0-9]/g, '');
}

function firstString(...values) {
  return values.find(value => typeof value === 'string' && value.trim())?.trim() || '';
}

function getPhone(contact) {
  const phoneValue = Array.isArray(contact?.phone) ? contact.phone[0] : contact?.phone;
  return cleanPhone(firstString(
    phoneValue,
    contact?.whatsappNumber,
    contact?.mobile,
    contact?.formattedPhone?.[0]
  ));
}

function getMessageId(message, contactId) {
  if (message?.id) return String(message.id);

  const fallback = JSON.stringify({
    contactId,
    createdAt: message?.createdAt || '',
    sender: message?.sender || '',
    text: extractText(message),
    media: extractAudioUrl(message)
  });

  return `fallback-${crypto.createHash('sha256').update(fallback).digest('hex')}`;
}

function extractButton(message) {
  const button = message?.whatsapp?.button || message?.button;
  const interactive = message?.whatsapp?.interactive || message?.interactive;
  const buttonReply = interactive?.button_reply || interactive?.buttonReply;
  const listReply = interactive?.list_reply || interactive?.listReply;

  return {
    payload: firstString(
      button?.payload,
      button?.id,
      buttonReply?.id,
      listReply?.id
    ),
    text: firstString(
      button?.text,
      button?.title,
      buttonReply?.title,
      listReply?.title
    )
  };
}

function extractText(message) {
  const button = extractButton(message);
  const interactive = message?.whatsapp?.interactive || message?.interactive;

  return firstString(
    message?.whatsapp?.text?.body,
    message?.text?.body,
    message?.message?.text,
    typeof message?.text === 'string' ? message.text : '',
    button.payload,
    button.text,
    interactive?.body?.text
  );
}

function extractAudioUrl(message) {
  return firstString(
    message?.whatsapp?.audio?.path,
    message?.whatsapp?.audio?.link,
    message?.whatsapp?.audio?.url,
    message?.whatsapp?.voice?.path,
    message?.whatsapp?.voice?.link,
    message?.whatsapp?.voice?.url,
    message?.mediaUrl,
    message?.media?.url
  );
}

function isInbound(message, contactId) {
  return String(message?.sender || '') === String(contactId || '');
}

function normalizeMessage(message, { contact, contactId, transcription = null, transcriptionError = null } = {}) {
  const button = extractButton(message);
  const audioUrl = extractAudioUrl(message);
  let text = extractText(message);
  let voiceNoteStatus = 'not_voice';

  if (audioUrl) {
    voiceNoteStatus = transcription ? 'transcribed' : (transcriptionError ? 'failed' : 'pending');
    if (transcription) {
      text = `[Voice Note Transcribed]: ${transcription}`;
    } else if (!text) {
      text = '[Voice note received but could not be transcribed]';
    }
  }

  return {
    message_id: getMessageId(message, contactId),
    conversation_id: message?.conversationId || message?.conversation_id || null,
    contact_id: contactId || null,
    sender_phone: getPhone(contact),
    sender_name: contact?.name || contact?.firstName || 'Valued Investor',
    message_text: text || 'Hello',
    button_payload: button.payload || '',
    button_text: button.text || '',
    audio_url: audioUrl || '',
    voice_note_status: voiceNoteStatus,
    voice_note_transcription: transcription || '',
    event_type: 'message.received',
    source: 'gallabox-poller',
    received_at: message?.createdAt || new Date().toISOString()
  };
}

module.exports = {
  cleanPhone,
  extractAudioUrl,
  extractButton,
  extractText,
  getMessageId,
  getPhone,
  isInbound,
  normalizeMessage
};
