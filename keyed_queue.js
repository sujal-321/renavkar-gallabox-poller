'use strict';

class KeyedSerialQueue {
  constructor() {
    this.tails = new Map();
  }

  run(key, task) {
    const previous = this.tails.get(key) || Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(task);

    const settled = current.catch(() => undefined);
    const tail = settled.finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    this.tails.set(key, tail);

    return current;
  }
}

module.exports = { KeyedSerialQueue };
