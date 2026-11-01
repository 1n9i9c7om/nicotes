import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarPlus, Check, Copy, XCircle } from 'lucide-react';
import { calendarFeedPath, type ApiToken, type CreatedApiToken } from '@nicotes/shared';
import { api } from '../lib/api';
import { timeAgo } from '../lib/format';

/** Shared with the API token card, so both lists stay in step. */
const tokensKey = ['api-tokens'] as const;

/**
 * Part of the Tasks card: a secret address calendar apps subscribe to. Its token is stored
 * hashed, so the address is shown once; a new one replaces the old.
 */
export function SettingsCalendar() {
  const qc = useQueryClient();
  const tokens = useQuery({ queryKey: tokensKey, queryFn: () => api.get<ApiToken[]>('/tokens') });
  const existing = tokens.data?.filter((t) => t.scope === 'calendar') ?? [];
  const [copied, setCopied] = useState(false);

  const create = useMutation({
    mutationFn: async () => {
      // One subscription address at a time: the new one replaces the old ones.
      for (const old of existing) await api.delete(`/tokens/${old.id}`);
      return api.post<CreatedApiToken>('/tokens', { name: 'Calendar feed', scope: 'calendar' });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: tokensKey }),
  });
  const remove = useMutation({
    mutationFn: async () => {
      for (const old of existing) await api.delete(`/tokens/${old.id}`);
    },
    onSuccess: () => create.reset(),
    onSettled: () => qc.invalidateQueries({ queryKey: tokensKey }),
  });

  const fresh = create.data;
  const url = fresh ? `${window.location.origin}${calendarFeedPath(fresh.token)}` : null;
  const copy = () => void navigator.clipboard.writeText(url!).then(() => setCopied(true));
  const current = existing[0];

  return (
    <div className="setting" id="calendar">
      <span className="setting-label">Calendar subscription</span>
      <p className="setting-hint">
        Open tasks with a due date as all-day events in Google Calendar, Apple Calendar, Thunderbird or any app that
        subscribes to calendars by address. They update about once an hour; done tasks disappear.
      </p>

      {url && (
        <div className="token-created" role="status">
          <p>Add this address as a calendar subscription. Copy it now, it won't be shown again.</p>
          <div className="setting-row">
            <input readOnly value={url} aria-label="Calendar address" onFocus={(e) => e.target.select()} />
            <button type="button" className="btn" onClick={copy}>
              {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="setting-hint">
            On an iPhone or Mac, <a href={url.replace(/^https?:/, 'webcal:')}>open it in Calendar</a>. Anyone with the
            address can see these tasks, so keep it to yourself.
          </p>
        </div>
      )}

      {!url && current && (
        <p className="setting-hint">
          A subscription address exists (created {timeAgo(current.createdAt)},{' '}
          {current.lastUsedAt ? `last fetched ${timeAgo(current.lastUsedAt)}` : 'not fetched yet'}).
        </p>
      )}

      <div className="setting-actions">
        <button
          type="button"
          className="btn"
          disabled={create.isPending || tokens.isPending}
          onClick={() => {
            setCopied(false);
            create.mutate();
          }}
        >
          <CalendarPlus size={15} /> {current || fresh ? 'New address' : 'Create address'}
        </button>
        {(current || fresh) && (
          <button type="button" className="btn" disabled={remove.isPending} onClick={() => remove.mutate()}>
            Stop sharing
          </button>
        )}
      </div>
      {current && !fresh && (
        <p className="setting-hint">A new address replaces the current one; calendars using the old one stop updating.</p>
      )}
      {(create.error ?? remove.error) && (
        <p className="check fail">
          <XCircle size={15} /> {(create.error ?? remove.error)!.message}
        </p>
      )}
    </div>
  );
}
