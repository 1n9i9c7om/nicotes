import { addressForm, hasSiteAccess, loadAddress, onAddressChange } from './address.js';

const api = globalThis.browser ?? globalThis.chrome;
const current = document.getElementById('current');
const access = document.getElementById('access');

/** Shows the saved address and whether the extension may access that site. */
async function showState() {
  const address = await loadAddress();
  current.textContent = address ?? 'No address yet';
  const granted = address !== null && (await hasSiteAccess(address));
  access.textContent = address === null ? '—' : granted ? 'Granted' : 'Not granted: save the address again';
  access.className = address === null ? '' : granted ? 'yes' : 'no';
}

addressForm(document.querySelector('form'));
onAddressChange(showState);
api.permissions.onAdded?.addListener(showState);
api.permissions.onRemoved?.addListener(showState);
await showState();
