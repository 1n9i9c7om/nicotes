import { randomBytes } from 'node:crypto';

/**
 * Values that live a few minutes in memory: sign-in tickets, secrets waiting for their first
 * code, WebAuthn challenges. Capped, so unauthenticated callers cannot fill the memory.
 */
export class Pending<T> {
  private entries = new Map<string, { value: T; expiresAt: number }>();
  constructor(
    private ttlMs: number,
    private max = 1000,
  ) {}

  /** Stores `value` under a new random id, or under `id` (replacing what was there). */
  put(value: T, id = randomBytes(24).toString('base64url')): string {
    const now = Date.now();
    for (const [key, entry] of this.entries) if (entry.expiresAt < now) this.entries.delete(key);
    this.entries.delete(id);
    while (this.entries.size >= this.max) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(id, { value, expiresAt: now + this.ttlMs });
    return id;
  }

  get(id: string): T | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.entries.delete(id);
      return undefined;
    }
    return entry.value;
  }

  /** Gets and removes: for one-time values. */
  take(id: string): T | undefined {
    const value = this.get(id);
    this.entries.delete(id);
    return value;
  }

  delete(id: string) {
    this.entries.delete(id);
  }
}
