'use strict';

const fs = require('fs');
const path = require('path');

function defaultState() {
  return {
    version: 1,
    messages: {},
    updatedAt: new Date(0).toISOString()
  };
}

class JsonStateStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = defaultState();
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        this.state = {
          ...defaultState(),
          ...parsed,
          messages: parsed.messages || {}
        };
      }
    } catch (error) {
      console.error(`State load failed; starting with an empty state: ${error.message}`);
      this.state = defaultState();
    }

    return this.state;
  }

  save() {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    this.state.updatedAt = new Date().toISOString();

    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(this.state, null, 2), 'utf8');
    fs.renameSync(tempPath, this.filePath);
  }

  getMessage(messageId) {
    return this.state.messages[messageId] || null;
  }

  mark(messageId, data) {
    this.state.messages[messageId] = {
      ...(this.state.messages[messageId] || {}),
      ...data,
      updatedAt: new Date().toISOString()
    };
    this.save();
  }

  remove(messageId) {
    delete this.state.messages[messageId];
    this.save();
  }

  prune(maxAgeMs) {
    const cutoff = Date.now() - maxAgeMs;
    let changed = false;
    for (const [messageId, record] of Object.entries(this.state.messages)) {
      const timestamp = new Date(record.updatedAt || record.createdAt || 0).getTime();
      if (timestamp && timestamp < cutoff) {
        delete this.state.messages[messageId];
        changed = true;
      }
    }
    if (changed) this.save();
  }
}

module.exports = { JsonStateStore, defaultState };
