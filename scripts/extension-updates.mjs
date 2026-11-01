// Writes the Firefox update manifest (updates.json) for a self-distributed extension: Firefox
// polls the manifest's update_url and installs the newest version listed there.
// Usage: node scripts/extension-updates.mjs <manifest.json> <signed.xpi> <xpi URL> > updates.json
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const [manifestPath, xpiPath, link] = process.argv.slice(2);
if (!manifestPath || !xpiPath || !link) {
  console.error('Usage: node scripts/extension-updates.mjs <manifest.json> <signed.xpi> <xpi URL>');
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const gecko = manifest.browser_specific_settings.gecko;
const hash = createHash('sha256').update(readFileSync(xpiPath)).digest('hex');

const update = {
  version: manifest.version,
  update_link: link,
  // Firefox checks the downloaded file against it.
  update_hash: `sha256:${hash}`,
  // Update manifests still call this "applications" (Firefox ignores browser_specific_settings here).
  ...(gecko.strict_min_version && { applications: { gecko: { strict_min_version: gecko.strict_min_version } } }),
};
console.log(JSON.stringify({ addons: { [gecko.id]: { updates: [update] } } }, null, 2));
