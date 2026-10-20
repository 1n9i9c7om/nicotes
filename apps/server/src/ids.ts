import { randomBytes } from 'node:crypto';

/** Short, URL-safe random id (72 bits). */
export function newId(): string {
  return randomBytes(9).toString('base64url');
}
