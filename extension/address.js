// The Nicotes address, kept in extension storage and shared by the sidebar and the options page.
const api = globalThis.browser ?? globalThis.chrome;

/**
 * "notes.example.com/" → "https://notes.example.com", "localhost:3000" → "http://localhost:3000";
 * null when it isn't a web address.
 */
export function normalizeAddress(input) {
  const text = input.trim();
  if (!text) return null;
  const scheme = /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(text) ? 'http' : 'https';
  let url;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `${scheme}://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * Access to the Nicotes site. Without it the browser treats Nicotes in the sidebar as a
 * third-party frame and withholds its login cookie, so every request is signed out.
 */
export function sitePermission(address) {
  const { protocol, hostname } = new URL(address);
  return { origins: [`${protocol}//${hostname}/*`] };
}

export const hasSiteAccess = (address) => api.permissions.contains(sitePermission(address));

export async function loadAddress() {
  const { address } = await api.storage.local.get('address');
  return typeof address === 'string' ? address : null;
}

export function onAddressChange(listener) {
  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'address' in changes) listener(changes.address.newValue ?? null);
  });
}

function report(status, kind, text) {
  status.dataset.kind = kind;
  status.textContent = text;
}

/** Wires up the address form: prefilled with the saved address; saves once access is granted. */
export async function addressForm(form) {
  const input = form.elements.namedItem('address');
  const status = form.querySelector('.status');
  input.value = (await loadAddress()) ?? '';
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const address = normalizeAddress(input.value);
    if (!address) {
      report(status, 'error', 'Enter a web address, for example https://notes.example.com.');
      input.focus();
      return;
    }
    input.value = address;
    // Firefox only asks for a permission straight from the click, before anything is awaited.
    api.permissions.request(sitePermission(address)).then(
      async (granted) => {
        if (!granted) {
          report(status, 'error', 'Nicotes needs access to this site to keep you signed in in the sidebar.');
          return;
        }
        await api.storage.local.set({ address });
        report(status, 'ok', 'Saved.');
      },
      (error) => report(status, 'error', error.message),
    );
  });
}
