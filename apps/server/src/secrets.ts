import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * AES-256-GCM encryption for secrets stored in the database (API keys, tokens).
 * The key comes from NICOTES_SECRET, or a random key file created next to the database.
 * This keeps secrets out of database dumps/backups; it does not protect against someone
 * who can read the whole data directory.
 */
export class SecretBox {
  private constructor(private key: Buffer) {}

  static fromSecret(secret: string) {
    return new SecretBox(createHash('sha256').update(secret).digest());
  }

  /** Uses `secret` if given, else reads or creates `<dataDir>/secret.key`. */
  static load(dataDir: string, secret?: string) {
    if (secret) return SecretBox.fromSecret(secret);
    const file = join(dataDir, 'secret.key');
    if (!existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600 });
    }
    return SecretBox.fromSecret(readFileSync(file, 'utf8').trim());
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
  }

  /** Returns null when the value cannot be decrypted (e.g. the key changed). */
  decrypt(stored: string): string | null {
    const [version, iv, tag, data] = stored.split(':');
    if (version !== 'v1' || !iv || !tag || !data) return null;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }
}
