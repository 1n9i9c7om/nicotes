import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, XCircle } from 'lucide-react';
import { API_TOKEN_SCOPE_LABELS, type ApiToken, type ApiTokenCreate, type ApiTokenScope, type CreatedApiToken } from '@nicotes/shared';
import { api } from '../lib/api';
import { timeAgo } from '../lib/format';

const tokensKey = ['api-tokens'] as const;

const EXPIRY: { days: number | null; label: string }[] = [
  { days: null, label: 'Never' },
  { days: 30, label: 'In 30 days' },
  { days: 90, label: 'In 90 days' },
  { days: 365, label: 'In a year' },
];

function details(t: ApiToken) {
  const parts = [API_TOKEN_SCOPE_LABELS[t.scope], `ends in …${t.hint}`, `created ${timeAgo(t.createdAt)}`];
  parts.push(t.lastUsedAt ? `last used ${timeAgo(t.lastUsedAt)}` : 'never used');
  if (t.expiresAt) parts.push(t.expiresAt < Date.now() ? 'expired' : `expires ${new Date(t.expiresAt).toLocaleDateString('en', { dateStyle: 'medium' })}`);
  return parts.join(' · ');
}

/** Settings card: personal access tokens for scripts and other apps. */
export function SettingsTokens() {
  const qc = useQueryClient();
  const tokens = useQuery({ queryKey: tokensKey, queryFn: () => api.get<ApiToken[]>('/tokens') });
  const create = useMutation({
    mutationFn: (input: ApiTokenCreate) => api.post<CreatedApiToken>('/tokens', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: tokensKey }),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/tokens/${id}`),
    onSettled: () => qc.invalidateQueries({ queryKey: tokensKey }),
  });
  const [name, setName] = useState('');
  const [scope, setScope] = useState<ApiTokenScope>('read');
  const [days, setDays] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setCopied(false);
    create.mutate({ name: name.trim(), scope, expiresInDays: days }, { onSuccess: () => setName('') });
  };
  const fresh = create.data;
  const copy = () => void navigator.clipboard.writeText(fresh!.token).then(() => setCopied(true));

  return (
    <section className="settings-card" id="tokens">
      <h2>
        <KeyRound size={18} /> API tokens
      </h2>
      <p className="muted">
        Let scripts and other apps use Nicotes, such as iOS Shortcuts, Home Assistant or a script of your own. A token
        acts as you: read-only ones can look at your notes, the others can change them too. No token can change settings,
        download backups or create tokens.
      </p>

      <form className="token-form" onSubmit={submit}>
        <label>
          <span className="setting-label">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Home Assistant" maxLength={80} />
        </label>
        <label>
          <span className="setting-label">Access</span>
          <select value={scope} onChange={(e) => setScope(e.target.value as ApiTokenScope)}>
            <option value="read">{API_TOKEN_SCOPE_LABELS.read}</option>
            <option value="write">{API_TOKEN_SCOPE_LABELS.write}</option>
          </select>
        </label>
        <label>
          <span className="setting-label">Expires</span>
          <select value={days ?? ''} onChange={(e) => setDays(e.target.value ? Number(e.target.value) : null)}>
            {EXPIRY.map((x) => (
              <option key={x.label} value={x.days ?? ''}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
        <button className="btn btn-primary" disabled={!name.trim() || create.isPending}>
          {create.isPending ? 'Creating…' : 'Create token'}
        </button>
      </form>
      {create.error && (
        <p className="check fail">
          <XCircle size={15} /> {create.error.message}
        </p>
      )}

      {fresh && (
        <div className="token-created" role="status">
          <p>
            <strong>{fresh.info.name}</strong>: copy the token now, it won't be shown again.
          </p>
          <div className="setting-row">
            <input readOnly value={fresh.token} aria-label="New API token" onFocus={(e) => e.target.select()} />
            <button type="button" className="btn" onClick={copy}>
              {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="setting-hint">
            Send it as <code>Authorization: Bearer {fresh.token.slice(0, 8)}…</code>, for example{' '}
            <code>curl -H "Authorization: Bearer …" {window.location.origin}/api/notebooks</code>.
          </p>
          <button type="button" className="link-btn" onClick={() => create.reset()}>
            Done
          </button>
        </div>
      )}

      {tokens.data && tokens.data.length > 0 && (
        <div className="setting">
          <span className="setting-label">Your tokens</span>
          <ul className="trash-list">
            {tokens.data.map((t) => (
              <li key={t.id} className="trash-item">
                <div className="trash-info">
                  <span className="trash-title">{t.name}</span>
                  <span className="trash-meta">{details(t)}</span>
                </div>
                {confirming === t.id ? (
                  <span className="token-confirm">
                    <button
                      className="btn btn-sm btn-danger"
                      disabled={revoke.isPending}
                      onClick={() => revoke.mutate(t.id, { onSettled: () => setConfirming(null) })}
                    >
                      Revoke now
                    </button>
                    <button className="btn btn-sm" onClick={() => setConfirming(null)}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button className="btn btn-sm" onClick={() => setConfirming(t.id)}>
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
