import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCircle2, Send, XCircle } from 'lucide-react';
import type { PushDevice, ReminderStatus, ReminderTestResult, Settings, SettingsUpdate } from '@nicotes/shared';
import { api } from '../lib/api';
import { deviceName } from '../lib/device';
import { timeAgo } from '../lib/format';
import { currentEndpoint, pushSupported, subscribePush, unsubscribeHere } from '../lib/push';
import { keys } from '../lib/queries';

interface Props {
  reminders: Settings['reminders'];
  save: (input: SettingsUpdate) => void;
  /** The bot token field, as Settings shows secret fields. */
  telegramToken: ReactNode;
}

/**
 * Settings card: when reminders come (times after tasks, a morning summary) and where to (push
 * notifications on devices, a Telegram chat).
 */
export function SettingsReminders({ reminders, save, telegramToken }: Props) {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: keys.reminders,
    queryFn: () => api.get<ReminderStatus>('/reminders'),
    // While waiting for Start in Telegram, look for the linked chat.
    refetchInterval: (q) => (q.state.data?.telegram.linkUrl ? 3000 : false),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: keys.reminders });
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zone = reminders.timeZone;
  // Times mean the browser's time zone unless one was saved.
  const withZone = (input: SettingsUpdate) => save(zone ? input : { ...input, reminderTimeZone: browserZone });
  const [digestTime, setDigestTime] = useState(reminders.digestTime ?? '08:00');
  const [here, setHere] = useState<string | null>(null);

  const vapidKey = status.data?.vapidPublicKey;
  const devices = status.data?.devices;
  useEffect(() => {
    if (vapidKey) void currentEndpoint(vapidKey).then(setHere);
  }, [vapidKey, devices]);

  const enable = useMutation({
    mutationFn: () => subscribePush(vapidKey!, deviceName()),
    onSuccess: () => {
      if (!zone) save({ reminderTimeZone: browserZone });
      void refresh();
    },
  });
  const remove = useMutation({
    mutationFn: async (device: PushDevice) => {
      if (device.endpoint === here) await unsubscribeHere();
      await api.delete(`/reminders/push/${device.id}`);
    },
    onSettled: refresh,
  });
  const link = useMutation({
    mutationFn: () => api.post<{ url: string }>('/reminders/telegram/link'),
    onSuccess: ({ url }) => {
      window.open(url, '_blank', 'noopener');
      if (!zone) save({ reminderTimeZone: browserZone });
      void refresh();
    },
  });
  const unlink = useMutation({ mutationFn: () => api.delete('/reminders/telegram'), onSettled: refresh });
  const test = useMutation({ mutationFn: () => api.post<ReminderTestResult[]>('/reminders/test') });

  const telegram = status.data?.telegram;
  const error = enable.error ?? remove.error ?? link.error ?? unlink.error;

  return (
    <section className="settings-card" id="reminders">
      <h2>
        <Bell size={18} /> Reminders
      </h2>
      <p className="muted">
        Write <code>⏰ 09:00</code> after a task with a due date, or <code>⏰ 2026-11-04 09:00</code> after any task, to
        be reminded then. A summary of the day's tasks can come every morning too.
      </p>

      <div className="setting">
        <span className="setting-label">Morning summary</span>
        <div className="reminder-digest">
          <label className="check-row">
            <input
              type="checkbox"
              checked={reminders.digestTime !== null}
              onChange={(e) => withZone({ reminderDigestTime: e.target.checked ? digestTime : null })}
            />
            Tasks due today (and overdue ones) at
          </label>
          <input
            type="time"
            aria-label="Summary time"
            value={digestTime}
            onChange={(e) => setDigestTime(e.target.value)}
            onBlur={() => reminders.digestTime !== null && digestTime && digestTime !== reminders.digestTime && withZone({ reminderDigestTime: digestTime })}
          />
        </div>
        <p className="setting-hint">
          Times are in {zone ?? `${browserZone}, this browser's time zone`}.{' '}
          {zone && zone !== browserZone && (
            <button type="button" className="link-btn" onClick={() => save({ reminderTimeZone: browserZone })}>
              Use {browserZone}
            </button>
          )}
        </p>
      </div>

      <div className="setting">
        <span className="setting-label">Notifications</span>
        <p className="setting-hint">
          On this device, also while Nicotes is closed. On an iPhone or iPad, add Nicotes to the Home Screen first and turn
          them on from there.
        </p>
        {devices && devices.length > 0 && (
          <ul className="trash-list">
            {devices.map((d) => (
              <li key={d.id} className="trash-item">
                <div className="trash-info">
                  <span className="trash-title">
                    {d.name}
                    {d.endpoint === here && <span className="muted"> · this device</span>}
                  </span>
                  <span className="trash-meta">
                    added {timeAgo(d.createdAt)} · {d.lastSentAt ? `last reminder ${timeAgo(d.lastSentAt)}` : 'nothing sent yet'}
                  </span>
                </div>
                <button className="btn btn-sm" disabled={remove.isPending} onClick={() => remove.mutate(d)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        {!pushSupported() ? (
          <p className="setting-hint">
            {window.isSecureContext
              ? 'This browser cannot show notifications from Nicotes.'
              : 'Notifications need Nicotes to be opened over HTTPS.'}
          </p>
        ) : (
          !here && (
            <div className="setting-actions">
              <button className="btn" disabled={!vapidKey || enable.isPending} onClick={() => enable.mutate()}>
                <Bell size={15} /> Turn on for this device
              </button>
            </div>
          )
        )}
      </div>

      <div className="setting">
        <span className="setting-label">Telegram</span>
        <p className="setting-hint">
          Ask{' '}
          <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">
            @BotFather
          </a>{' '}
          in Telegram for a new bot (<code>/newbot</code>), paste its token here, then connect your chat with it. Besides
          reminders, you can talk to the chat assistant there (/todo and /calendar have buttons). The bot only answers
          the Telegram account that connected it, in a private chat; groups can't be connected.
        </p>
        {telegramToken}
        {telegram?.error && (
          <p className="check fail">
            <XCircle size={15} /> {telegram.error}
          </p>
        )}
        {telegram?.bot &&
          (telegram.connected ? (
            <div className="setting-actions">
              <span className="check ok">
                <CheckCircle2 size={15} /> Reminders go to your chat with @{telegram.bot}
                {telegram.account && <> ({telegram.account}; nobody else is answered)</>}
              </span>
              <button className="btn btn-sm" disabled={unlink.isPending} onClick={() => unlink.mutate()}>
                Disconnect
              </button>
            </div>
          ) : telegram.linkUrl ? (
            <p className="setting-hint">
              Waiting for you to press <strong>Start</strong> in Telegram…{' '}
              <a href={telegram.linkUrl} target="_blank" rel="noreferrer">
                Open @{telegram.bot}
              </a>
            </p>
          ) : (
            <div className="setting-actions">
              <button className="btn" disabled={link.isPending} onClick={() => link.mutate()}>
                <Send size={15} /> Connect @{telegram.bot}
              </button>
            </div>
          ))}
      </div>

      <div className="setting-actions">
        <button className="btn" disabled={test.isPending} onClick={() => test.mutate()}>
          {test.isPending ? 'Sending…' : 'Send a test reminder'}
        </button>
        {test.error && (
          <span className="check fail">
            <XCircle size={15} /> {test.error.message}
          </span>
        )}
      </div>
      {test.data?.map((r) => (
        <p key={`${r.channel}-${r.target}`} className={`check ${r.ok ? 'ok' : 'fail'}`}>
          {r.ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />} {r.target}: {r.message}
        </p>
      ))}
      {error && (
        <p className="check fail">
          <XCircle size={15} /> {error.message}
        </p>
      )}
    </section>
  );
}
