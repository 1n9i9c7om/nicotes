import type { PushDevice } from '@nicotes/shared';
import { api } from './api';

/** Push needs a service worker (the built app, not the dev server) and HTTPS or localhost. */
export const pushSupported = () =>
  window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64url.length / 4) * 4, '=');
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array) =>
  !!a && a.byteLength === b.length && new Uint8Array(a).every((byte, i) => byte === b[i]);

/** The service worker, or an error when there is none (e.g. in development). */
async function registration(): Promise<ServiceWorkerRegistration> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('The app is not installed as a web app here (no service worker).')), 5000),
  );
  return Promise.race([navigator.serviceWorker.ready, timeout]);
}

/** This browser's subscription address, if it has one for these keys. */
export async function currentEndpoint(vapidPublicKey: string): Promise<string | null> {
  if (!pushSupported() || Notification.permission !== 'granted') return null;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub && sameKey(sub.options.applicationServerKey, keyBytes(vapidPublicKey)) ? sub.endpoint : null;
}

/** Asks for permission, subscribes this browser and registers it with the server. */
export async function subscribePush(vapidPublicKey: string, name: string): Promise<PushDevice> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(
      permission === 'denied'
        ? 'Notifications are blocked for this site. Allow them in the browser’s site settings, then try again.'
        : 'Notifications were not allowed.',
    );
  }
  const reg = await registration();
  const key = keyBytes(vapidPublicKey);
  let sub = await reg.pushManager.getSubscription();
  // Made for other keys (the server's were renewed): replace it.
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  try {
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  } catch (err) {
    const name = (err as Error).name;
    if (name === 'NotAllowedError' || name === 'AbortError') {
      throw new Error('The browser refused notifications here. Private windows cannot get them; try a normal window or the installed app.');
    }
    throw err;
  }
  const json = sub.toJSON();
  return api.post<PushDevice>('/reminders/push', { endpoint: json.endpoint, keys: json.keys, name });
}

/** Stops push in this browser (the server entry is removed separately). */
export async function unsubscribeHere() {
  const reg = await navigator.serviceWorker.getRegistration();
  await (await reg?.pushManager.getSubscription())?.unsubscribe();
}
