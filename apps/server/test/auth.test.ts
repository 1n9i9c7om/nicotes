import { describe, expect, it } from 'vitest';
import { initialPasswordProblem } from '../src/auth.js';

describe('the account from NICOTES_ADMIN_USER / NICOTES_ADMIN_PASSWORD', () => {
  it('is refused with the example password from .env.example', () => {
    expect(initialPasswordProblem('change-me')).toMatch(/example password/);
    expect(initialPasswordProblem(' Change-Me ')).toMatch(/example password/);
  });

  it('follows the setup screen’s password policy', () => {
    expect(initialPasswordProblem('short')).toMatch(/8 to 256 characters/);
    expect(initialPasswordProblem('x'.repeat(257))).toMatch(/8 to 256 characters/);
  });

  it('is created with a password of your own', () => {
    expect(initialPasswordProblem('correct horse battery')).toBeNull();
  });
});
