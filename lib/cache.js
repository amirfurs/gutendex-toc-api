export class LruTtlCache {
  constructor(maxEntries = 200) {
    this.maxEntries = maxEntries;
    this.store = new Map();
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key, value, ttlMs) {
    const expiresAt = Date.now() + ttlMs;
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { value, expiresAt });

    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      this.store.delete(oldest);
    }
  }
}

export const TTL = {
  metadata: 10 * 60 * 1000,
  toc: 24 * 60 * 60 * 1000,
  content: 30 * 60 * 1000,
};
