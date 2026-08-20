'use strict';

function calculateAdaptiveDelay(message) {
  if (!message) return 1800;

  // Buttons/Quick replies require instant response (0ms)
  if (message.button_payload || message.button_text) {
    return 0;
  }

  // Voice note transcriptions are already complete sentences
  if (message.voice_note_status === 'transcribed') {
    return 500;
  }

  const text = String(message.message_text || '').trim();

  // Questions or punctuated full sentences don't need long bundling delays
  if (text.endsWith('?') || text.endsWith('!') || text.split(/\s+/).length >= 6) {
    return 1200;
  }

  // Short greetings / words (e.g. "hi", "hey", "prelease")
  return 1800;
}

class MessageDebouncer {
  constructor({ debounceMs = null, onFlush } = {}) {
    this.debounceMs = debounceMs; // null means adaptive mode
    this.onFlush = onFlush;
    this.buffers = new Map();
  }

  getDelayForMessage(message) {
    if (this.debounceMs !== null && Number.isFinite(this.debounceMs)) {
      return this.debounceMs;
    }
    return calculateAdaptiveDelay(message);
  }

  push(phone, normalizedMessage, contact) {
    let entry = this.buffers.get(phone);
    if (!entry) {
      entry = { items: [], timer: null, contact, resolves: [], rejects: [] };
      this.buffers.set(phone, entry);
    } else if (entry.timer) {
      clearTimeout(entry.timer);
    }

    entry.items.push(normalizedMessage);
    entry.contact = contact;

    const delay = this.getDelayForMessage(normalizedMessage);

    const flush = async () => {
      this.buffers.delete(phone);
      try {
        const mergedText = entry.items
          .map(item => String(item.message_text || '').trim())
          .filter(Boolean)
          .join('\n');

        const lastItem = entry.items[entry.items.length - 1];
        const allMessageIds = entry.items.map(item => item.message_id);

        const bundledPayload = {
          ...lastItem,
          message_text: mergedText,
          bundled_message_ids: allMessageIds
        };

        const result = this.onFlush
          ? await this.onFlush(bundledPayload, entry.contact, allMessageIds)
          : { ok: true, message_id: lastItem.message_id };

        entry.resolves.forEach(res => res(result));
      } catch (err) {
        entry.rejects.forEach(rej => rej(err));
      }
    };

    return new Promise((resolve, reject) => {
      entry.resolves.push(resolve);
      entry.rejects.push(reject);

      if (delay <= 0) {
        setImmediate(flush);
      } else {
        entry.timer = setTimeout(flush, delay);
      }
    });
  }

  isPending(phone) {
    return this.buffers.has(phone);
  }

  clear() {
    for (const [, entry] of this.buffers.entries()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.buffers.clear();
  }
}

module.exports = { MessageDebouncer, calculateAdaptiveDelay };

