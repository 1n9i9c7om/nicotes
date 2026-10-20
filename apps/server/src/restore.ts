/**
 * Restores a backup into DATA_DIR while the server is stopped:
 *
 *   npm run restore -- <archive>            (development, from the repository)
 *   node apps/server/dist/restore.js <archive>   (production / Docker)
 *
 * See the README ("Backups") for the Docker steps.
 */
import { get } from 'node:http';
import { resolve } from 'node:path';
import { restoreBackup } from './backup/restore.js';
import { config } from './config.js';

/** Whether something answers Nicotes' health check on the configured port. */
const serverRunning = () =>
  new Promise<boolean>((done) => {
    const req = get({ host: '127.0.0.1', port: config.port, path: '/api/health', timeout: 2000, agent: false }, (res) => {
      res.resume();
      done(res.statusCode === 200);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => done(false));
  });

async function main(args: string[]): Promise<number> {
  const force = args.includes('--force');
  const archive = args.find((a) => !a.startsWith('--'));
  if (!archive) {
    console.error('Usage: restore <backup.tar.gz> [--force]');
    console.error(`Restores into DATA_DIR (${config.dataDir}). Stop the server first.`);
    return 2;
  }

  // A running server keeps the old database open and would keep writing to it.
  if (!force && (await serverRunning())) {
    console.error(`Nicotes is still running on port ${config.port}. Stop it first (or pass --force if that is something else).`);
    return 1;
  }

  // `npm run` changes into the workspace folder; INIT_CWD is where the command was typed.
  const file = resolve(process.env.INIT_CWD ?? process.cwd(), archive);
  console.log(`Restoring ${file}\n     into ${config.dataDir}`);
  try {
    const result = await restoreBackup(file, config.dataDir);
    const files = `${result.attachments} attachment${result.attachments === 1 ? '' : 's'}`;
    console.log(`Restored the backup from ${new Date(result.manifest.createdAt).toLocaleString()} (${files}).`);
    if (result.previous) console.log(`The previous data was moved to ${result.previous}; delete it once everything looks right.`);
    if (result.manifest.secretFromEnv && !config.secret) {
      console.log('Note: this backup was made with NICOTES_SECRET. Set the same value again, or re-enter API keys in Settings.');
    }
    console.log('Start Nicotes again; pending database migrations run on start.');
    return 0;
  } catch (err) {
    console.error(`Restore failed: ${err instanceof Error ? err.message : String(err)}`);
    console.error('The data directory was left as it was.');
    return 1;
  }
}

// exitCode rather than process.exit(): exiting while sockets close trips a libuv assertion on Windows.
process.exitCode = await main(process.argv.slice(2));
