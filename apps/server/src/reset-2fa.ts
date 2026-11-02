/**
 * Turns two-step sign-in off for an account whose authenticator app and recovery codes are
 * gone, so the password alone signs in again:
 *
 *   npm run reset-2fa -- <username> [--passkeys]          (development, from the repository)
 *   node apps/server/dist/reset-2fa.js <username> [--passkeys]   (production / Docker)
 *
 * --passkeys removes the account's passkeys too, e.g. when the phone was stolen. Either way,
 * the account is signed out everywhere.
 */
import { eq } from 'drizzle-orm';
import { endAllSessions } from './auth.js';
import { config } from './config.js';
import { openDb } from './db/index.js';
import { passkeys, users } from './db/schema.js';
import { disableTotp, totpEnabled } from './twoFactor.js';

function main(args: string[]): number {
  const withPasskeys = args.includes('--passkeys');
  const username = args.find((a) => !a.startsWith('--'))?.trim().toLowerCase();
  if (!username) {
    console.error('Usage: reset-2fa <username> [--passkeys]');
    console.error('Turns two-step sign-in off for the account (and with --passkeys, removes its passkeys).');
    return 2;
  }

  const db = openDb(config.dbFile, config.migrationsFolder);
  try {
    const user = db.select({ id: users.id }).from(users).where(eq(users.username, username)).get();
    if (!user) {
      console.error(`There is no account "${username}" in ${config.dbFile}.`);
      return 1;
    }
    const hadTotp = totpEnabled(db, user.id);
    disableTotp(db, user.id);
    const removed = withPasskeys ? db.delete(passkeys).where(eq(passkeys.userId, user.id)).run().changes : 0;
    const sessions = endAllSessions(db, user.id);

    console.log(hadTotp ? `Two-step sign-in is now off for "${username}".` : `Two-step sign-in was already off for "${username}".`);
    if (withPasskeys) console.log(`Removed ${removed} passkey${removed === 1 ? '' : 's'}.`);
    console.log(`Signed out of ${sessions} session${sessions === 1 ? '' : 's'}. The password alone signs in now; set two-step sign-in up again in Settings.`);
    return 0;
  } finally {
    db.$client.close();
  }
}

process.exitCode = main(process.argv.slice(2));
