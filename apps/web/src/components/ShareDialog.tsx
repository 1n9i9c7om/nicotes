import { useState, type FormEvent, type ReactNode } from 'react';
import { Check, Copy, Globe, XCircle } from 'lucide-react';
import type { Share, ShareKind } from '@nicotes/shared';
import { timeAgo } from '../lib/format';
import { isExpired, shareUrl, useCreateShare, useDeleteShare, useShares } from '../lib/shares';
import { Modal } from './Modal';

const EXPIRY: { days: number | null; label: string }[] = [
  { days: null, label: 'Never' },
  { days: 1, label: 'In a day' },
  { days: 7, label: 'In a week' },
  { days: 30, label: 'In 30 days' },
];

const dateOf = (time: number) => new Date(time).toLocaleDateString('en', { dateStyle: 'medium' });

/** "Page and subpages · expires … · viewed 3 times, last 2 hours ago" */
export function shareDetails(share: Share): string {
  const what = share.kind === 'notebook' ? 'Notebook' : share.includeChildren ? 'Page and subpages' : 'Page';
  const parts = [what];
  if (share.trashed) parts.push('in the trash, so nothing is shown');
  if (share.expiresAt) parts.push(isExpired(share) ? 'expired' : `until ${dateOf(share.expiresAt)}`);
  parts.push(
    share.viewCount
      ? `viewed ${share.viewCount === 1 ? 'once' : `${share.viewCount} times`}, last ${timeAgo(share.lastViewedAt!)}`
      : 'not opened yet',
  );
  return parts.join(' · ');
}

/** One link: its address to copy, what it shows, and turning it off. */
export function ShareLinkRow({ share, title }: { share: Share; title?: ReactNode }) {
  const remove = useDeleteShare();
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const url = shareUrl(share);
  return (
    <li className="share-link">
      {title && <span className="trash-title">{title}</span>}
      {url ? (
        <div className="setting-row">
          <input readOnly value={url} aria-label="Shared link" onFocus={(e) => e.target.select()} />
          <button type="button" className="btn" onClick={() => void navigator.clipboard.writeText(url).then(() => setCopied(true))}>
            {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      ) : (
        <p className="setting-hint">The server's secret key changed, so this link can't be shown. Turn it off and create a new one.</p>
      )}
      <div className="share-link-meta">
        <span className="trash-meta">{shareDetails(share)}</span>
        {confirming ? (
          <span className="token-confirm">
            <button className="btn btn-sm btn-danger" disabled={remove.isPending} onClick={() => remove.mutate(share.id)}>
              Turn off now
            </button>
            <button className="btn btn-sm" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <button className="btn btn-sm" onClick={() => setConfirming(true)}>
            Turn off
          </button>
        )}
      </div>
    </li>
  );
}

interface Props {
  kind: ShareKind;
  targetId: string;
  title: string;
  /** Pages: whether there are subpages to include. */
  hasChildren?: boolean;
  /** Pages: links of a parent page or the notebook that show this page too. */
  inherited?: { share: Share; title: string }[];
  onClose: () => void;
}

/** Page or notebook menu → Share…: read-only links anyone can open without an account. */
export function ShareDialog({ kind, targetId, title, hasChildren = false, inherited = [], onClose }: Props) {
  const shares = useShares();
  const create = useCreateShare();
  const [includeChildren, setIncludeChildren] = useState(true);
  const [days, setDays] = useState<number | null>(null);
  const links = shares.data?.filter((s) => s.kind === kind && s.targetId === targetId) ?? [];

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate({ kind, targetId, includeChildren: kind === 'page' && hasChildren && includeChildren, expiresInDays: days });
  };

  return (
    <Modal
      title={`Share “${title}”`}
      onClose={onClose}
      footer={
        <button className="btn" onClick={onClose}>
          Done
        </button>
      }
    >
      <p className="muted">
        Anyone with the link can read {kind === 'notebook' ? 'every page of this notebook' : 'this page'} without an
        account, but not change anything. Turn a link off to take it back.
      </p>

      {links.length > 0 && (
        <ul className="share-links">
          {links.map((s) => (
            <ShareLinkRow key={s.id} share={s} />
          ))}
        </ul>
      )}

      {inherited.length > 0 && (
        <p className="setting-hint">
          <Globe size={13} /> Also readable through the link to{' '}
          {inherited.map(({ share, title: via }, i) => (
            <span key={share.id}>
              {i > 0 && ', '}“{via}” ({share.kind === 'notebook' ? 'notebook' : 'page and subpages'})
            </span>
          ))}
          .
        </p>
      )}

      <form className="share-form" onSubmit={submit}>
        {kind === 'page' && hasChildren && (
          <label className="check-row">
            <input type="checkbox" checked={includeChildren} onChange={(e) => setIncludeChildren(e.target.checked)} />
            Include its subpages
          </label>
        )}
        <label className="share-expiry">
          <span className="setting-label">Link expires</span>
          <select value={days ?? ''} onChange={(e) => setDays(e.target.value ? Number(e.target.value) : null)}>
            {EXPIRY.map((x) => (
              <option key={x.label} value={x.days ?? ''}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
        <button className="btn btn-primary" disabled={create.isPending}>
          <Globe size={15} /> {links.length ? 'Create another link' : 'Create link'}
        </button>
      </form>
      {create.error && (
        <p className="check fail">
          <XCircle size={15} /> {create.error.message}
        </p>
      )}
    </Modal>
  );
}
