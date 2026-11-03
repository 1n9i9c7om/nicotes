import { z } from 'zod';

/** Daily summaries a day at most. */
export const MAX_DIGEST_TIMES = 4;

/**
 * The times of the daily summaries, sorted, from the setting ("07:30" or "07:30, 20:00").
 * The first is the morning summary; later ones tell what's still open and what's due tomorrow.
 */
export function parseDigestTimes(value: string | null | undefined): string[] {
  const times = (value ?? '').split(/[\s,;]+/).filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t));
  return [...new Set(times)].sort().slice(0, MAX_DIGEST_TIMES);
}

/** A browser or installed app that gets reminders as push notifications. */
export interface PushDevice {
  id: string;
  name: string;
  /** The push service address, so a browser can tell which entry is itself. */
  endpoint: string;
  createdAt: number;
  lastSentAt: number | null;
}

/** GET /api/reminders */
export interface ReminderStatus {
  /** VAPID public key (base64url) for `pushManager.subscribe`. */
  vapidPublicKey: string;
  devices: PushDevice[];
  telegram: {
    /** The bot's @name once its token works; null without a token. */
    bot: string | null;
    /** A chat is linked, so reminders go there. */
    connected: boolean;
    /** The Telegram account the chat is with (@username or first name), the only one answered. */
    account: string | null;
    /** While waiting for /start in Telegram: the link that opens the bot with the code. */
    linkUrl: string | null;
    /** Why the bot cannot be reached, e.g. a wrong token. */
    error: string | null;
  };
}

/** POST /api/reminders/push: what `PushSubscription.toJSON()` gives, plus a name. */
export const pushSubscribeSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
  name: z.string().trim().min(1).max(80),
});
export type PushSubscribe = z.infer<typeof pushSubscribeSchema>;

/** POST /api/reminders/test: one line per device or chat. */
export interface ReminderTestResult {
  channel: 'push' | 'telegram';
  target: string;
  ok: boolean;
  message: string;
}

/** What a push notification carries (the service worker shows it). */
export interface ReminderNotice {
  title: string;
  body: string;
  /** Opened when the notification is clicked, relative to the app. */
  url: string;
  /** Notifications with the same tag replace each other. */
  tag: string;
}
