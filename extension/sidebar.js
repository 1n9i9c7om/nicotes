import { addressForm, hasSiteAccess, loadAddress, onAddressChange } from './address.js';

const api = globalThis.browser ?? globalThis.chrome;
const frame = document.getElementById('app');
const setup = document.getElementById('setup');

/** Shows Nicotes, or the address form while there is no address or no access to the site. */
async function show() {
  const address = await loadAddress();
  const ready = address !== null && (await hasSiteAccess(address));
  setup.hidden = ready;
  frame.hidden = !ready;
  if (!ready) frame.removeAttribute('src');
  else if (frame.getAttribute('src') !== address) frame.src = address;
}

addressForm(setup.querySelector('form'));
onAddressChange(show);
api.permissions.onAdded?.addListener(show);
api.permissions.onRemoved?.addListener(show);
await show();
