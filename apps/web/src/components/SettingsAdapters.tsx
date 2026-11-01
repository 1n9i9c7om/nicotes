import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Plug, Plus, XCircle } from 'lucide-react';
import {
  ADAPTER_TYPE_INFO,
  ADAPTER_TYPES,
  type Adapter,
  type AdapterRun,
  type AdapterSave,
  type AdapterTarget,
  type AdapterType,
} from '@nicotes/shared';
import { api } from '../lib/api';
import { timeAgo } from '../lib/format';

const adaptersKey = ['adapters'] as const;

const TARGETS: Record<AdapterTarget, string> = {
  logbook: 'A logbook page: a row per day, shown as charts',
  journal: 'The journal: a line in the day’s note',
};

interface Draft extends Required<Omit<AdapterSave, 'secrets'>> {
  id: string | null;
  secrets: Record<string, string>;
  secretsSet: string[];
}

function draftOf(type: AdapterType, adapter?: Adapter): Draft {
  const info = ADAPTER_TYPE_INFO[type];
  return adapter
    ? { ...adapter, secrets: {} }
    : { id: null, type, name: info.label, config: {}, secrets: {}, secretsSet: [], target: info.target, dailyAt: info.dailyAt, enabled: true };
}

const bodyOf = (d: Draft): AdapterSave => ({
  type: d.type,
  name: d.name,
  config: d.config,
  // Empty secret fields keep what is stored.
  secrets: Object.fromEntries(Object.entries(d.secrets).filter(([, v]) => v.trim())),
  target: d.target,
  dailyAt: d.dailyAt,
  enabled: d.enabled,
});

function details(a: Adapter) {
  const parts = [ADAPTER_TYPE_INFO[a.type].label, a.target === 'logbook' ? 'into its logbook' : 'into the journal', `daily at ${a.dailyAt}`];
  if (!a.enabled) parts.push('paused');
  return parts.join(' · ');
}

/** Settings card: adapters that bring data from other services into logbooks or the journal. */
export function SettingsAdapters() {
  const qc = useQueryClient();
  const adapters = useQuery({ queryKey: adaptersKey, queryFn: () => api.get<Adapter[]>('/adapters') });
  const refresh = () => qc.invalidateQueries({ queryKey: adaptersKey });
  const run = useMutation({ mutationFn: (id: string) => api.post<AdapterRun>(`/adapters/${id}/run`), onSettled: refresh });
  const save = useMutation({
    mutationFn: (d: Draft) => (d.id ? api.put<Adapter>(`/adapters/${d.id}`, bodyOf(d)) : api.post<Adapter>('/adapters', bodyOf(d))),
    onSuccess: (adapter, d) => {
      setDraft(null);
      void refresh();
      // A first run right away shows whether the settings work.
      if (!d.id) run.mutate(adapter.id);
    },
  });
  const remove = useMutation({ mutationFn: (id: string) => api.delete(`/adapters/${id}`), onSettled: refresh });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const edit = (d: Draft | null) => {
    save.reset();
    setDraft(d);
  };

  return (
    <section className="settings-card" id="adapters">
      <h2>
        <Plug size={18} /> Adapters
      </h2>
      <p className="muted">
        Bring in data from other services once a day: sensor values from Home Assistant (solar energy, temperatures,
        consumption) or the weather forecast. Each adapter writes into a logbook page, a table with a row per day that
        the page view draws as charts, or a line in the day’s journal note.
      </p>

      {adapters.data && adapters.data.length > 0 && (
        <ul className="trash-list">
          {adapters.data.map((a) => (
            <li key={a.id} className="trash-item adapter-item">
              <div className="trash-info">
                <span className="trash-title">{a.name}</span>
                <span className="trash-meta">{details(a)}</span>
                {run.isPending && run.variables === a.id ? (
                  <span className="adapter-status">Reading…</span>
                ) : (
                  a.lastStatus && (
                    <span className={`adapter-status ${a.lastStatus === 'ok' ? 'ok' : 'fail'}`}>
                      {a.lastStatus === 'ok' ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                      <span>
                        {a.lastMessage} <span className="adapter-when">{a.lastRunAt ? `(${timeAgo(a.lastRunAt)})` : ''}</span>
                        {a.lastStatus === 'ok' &&
                          (a.target === 'logbook' && a.pageId ? (
                            <Link to={`/p/${a.pageId}`}>Open logbook</Link>
                          ) : (
                            a.target === 'journal' && <Link to="/journal">Open journal</Link>
                          ))}
                      </span>
                    </span>
                  )
                )}
              </div>
              {confirming === a.id ? (
                <span className="token-confirm">
                  <button
                    className="btn btn-sm btn-danger"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(a.id, { onSettled: () => setConfirming(null) })}
                  >
                    Remove now
                  </button>
                  <button className="btn btn-sm" onClick={() => setConfirming(null)}>
                    Cancel
                  </button>
                </span>
              ) : (
                <span className="trash-actions">
                  <button className="btn btn-sm" disabled={run.isPending} onClick={() => run.mutate(a.id)}>
                    Run now
                  </button>
                  <button className="btn btn-sm" onClick={() => edit(draftOf(a.type, a))}>
                    Edit
                  </button>
                  <button className="btn btn-sm" onClick={() => setConfirming(a.id)}>
                    Remove
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {draft ? (
        <AdapterForm
          draft={draft}
          onChange={setDraft}
          onSubmit={() => save.mutate(draft)}
          onCancel={() => edit(null)}
          pending={save.isPending}
          error={save.error?.message ?? null}
        />
      ) : (
        <div className="setting-actions">
          {ADAPTER_TYPES.map((type) => (
            <button key={type} className="btn" onClick={() => edit(draftOf(type))}>
              <Plus size={15} /> {ADAPTER_TYPE_INFO[type].label}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function AdapterForm({
  draft,
  onChange,
  onSubmit,
  onCancel,
  pending,
  error,
}: {
  draft: Draft;
  onChange: (d: Draft) => void;
  onSubmit: () => void;
  onCancel: () => void;
  pending: boolean;
  error: string | null;
}) {
  const info = ADAPTER_TYPE_INFO[draft.type];
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit();
  };
  return (
    <form className="adapter-form" onSubmit={submit} aria-label={draft.id ? `Edit ${draft.name}` : `New ${info.label} adapter`}>
      <div>
        <h3>{draft.id ? `Edit “${draft.name}”` : `New ${info.label} adapter`}</h3>
        <p className="setting-hint">{info.description}</p>
      </div>
      <Field label="Name" hint="Also the logbook page’s title, or the label of its line in the journal.">
        {(props) => <input {...props} value={draft.name} onChange={(e) => set({ name: e.target.value })} maxLength={80} required />}
      </Field>
      {info.fields.map((field) => (
        <Field key={field.key} label={field.label} hint={field.help}>
          {(props) =>
            field.kind === 'lines' ? (
              <textarea
                {...props}
                rows={4}
                value={draft.config[field.key] ?? ''}
                placeholder={field.placeholder}
                spellCheck={false}
                onChange={(e) => set({ config: { ...draft.config, [field.key]: e.target.value } })}
              />
            ) : field.kind === 'secret' ? (
              <input
                {...props}
                type="password"
                autoComplete="off"
                value={draft.secrets[field.key] ?? ''}
                placeholder={draft.secretsSet.includes(field.key) ? 'Stored; type a new one to replace it' : field.placeholder}
                onChange={(e) => set({ secrets: { ...draft.secrets, [field.key]: e.target.value } })}
              />
            ) : (
              <input
                {...props}
                type={field.kind === 'url' ? 'url' : 'text'}
                value={draft.config[field.key] ?? ''}
                placeholder={field.placeholder}
                onChange={(e) => set({ config: { ...draft.config, [field.key]: e.target.value } })}
              />
            )
          }
        </Field>
      ))}
      <div className="adapter-schedule">
        <Field label="Write into">
          {(props) => (
            <select {...props} value={draft.target} onChange={(e) => set({ target: e.target.value as AdapterTarget })}>
              {(Object.keys(TARGETS) as AdapterTarget[]).map((t) => (
                <option key={t} value={t}>
                  {TARGETS[t]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Every day at">
          {(props) => <input {...props} type="time" value={draft.dailyAt} onChange={(e) => set({ dailyAt: e.target.value })} required />}
        </Field>
      </div>
      {draft.id && (
        <label className="adapter-enabled">
          <input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Run every day
          (unticked, it only runs with Run now)
        </label>
      )}
      {error && (
        <p className="check fail">
          <XCircle size={15} /> {error}
        </p>
      )}
      <div className="setting-actions">
        <button className="btn btn-primary" disabled={pending || !draft.name.trim()}>
          {pending ? 'Saving…' : draft.id ? 'Save' : 'Add and run'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** A labelled control; the hint is its description, not part of its name. */
function Field({ label, hint, children }: { label: string; hint?: string; children: (props: { id: string; 'aria-describedby'?: string }) => ReactNode }) {
  const id = useId();
  return (
    <div className="setting">
      <label className="setting-label" htmlFor={id}>
        {label}
      </label>
      {children({ id, 'aria-describedby': hint ? `${id}-hint` : undefined })}
      {hint && (
        <span className="setting-hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
    </div>
  );
}
