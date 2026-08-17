'use strict';

class MessageDebouncer {
  constructor({ debounceMs = 5000, onFlush } = {}) {
    this.debounceMs = debounceMs;
    this.onFlush = onFlush;
    this.buffers = new Map();
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

    return new Promise((resolve, reject) => {
      entry.resolves.push(resolve);
      entry.rejects.push(reject);

      entry.timer = setTimeout(async () => {
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
      }, this.debounceMs);
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

module.exports = { MessageDebouncer };
