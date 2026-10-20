import { useSyncExternalStore } from 'react';

/** Chrome's install prompt event (not in the DOM typings). */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

// Registered at startup: the event fires once, early, and must be kept for later.
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferred = event as InstallPromptEvent;
  notify();
});
window.addEventListener('appinstalled', () => {
  deferred = null;
  notify();
});

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Whether the browser offers installing Nicotes right now, and a function to do it. */
export function useInstallPrompt() {
  const available = useSyncExternalStore(subscribe, () => deferred !== null);
  const install = async () => {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    notify();
  };
  const installed = window.matchMedia('(display-mode: standalone)').matches;
  return { available, installed, install };
}
