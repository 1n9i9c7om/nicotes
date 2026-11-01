// Sets Firefox's update_url in an extension manifest (CI, before packing and signing).
// Usage: node scripts/extension-update-url.mjs <manifest.json> <update URL>
import { readFileSync, writeFileSync } from 'node:fs';

const [file, url] = process.argv.slice(2);
if (!file || !url?.startsWith('https://')) {
  console.error(`Firefox needs an https:// update URL, got ${JSON.stringify(url)}.`);
  console.error('Usage: node scripts/extension-update-url.mjs <manifest.json> <https:// update URL>');
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(file, 'utf8'));
manifest.browser_specific_settings.gecko.update_url = url;
writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
