import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ArrowRight, CheckCircle2, FolderPlus, FolderTree, Hash, RotateCcw, Sparkles, Wand2 } from 'lucide-react';
import type { OrganizeRequest, OrganizeResult, OrganizeSuggestion } from '@nicotes/shared';
import { formatCost, JobProgress } from '../components/JobProgress';
import { useApplyOrganize, useBatches, useJob, useNotebooks, usePages, useStartOrganize, useUndoBatch } from '../lib/queries';
import { displayTitle } from '../lib/tree';

type ScopeKind = OrganizeRequest['scope']['kind'];

const SECTIONS: { type: OrganizeSuggestion['type']; title: string; icon: typeof Hash }[] = [
  { type: 'group', title: 'New groups', icon: FolderPlus },
  { type: 'move', title: 'Moves', icon: FolderTree },
  { type: 'tag', title: 'Tags', icon: Hash },
];

function SuggestionText({ s }: { s: OrganizeSuggestion }) {
  if (s.type === 'tag') {
    return (
      <>
        <strong>{displayTitle(s.pageTitle)}</strong>
        {s.tags.map((t) => (
          <span key={t} className={s.newTags.includes(t) ? 'tag-chip-link suggest-tag new' : 'tag-chip-link suggest-tag'}>
            #{t}
            {s.newTags.includes(t) && <em> new</em>}
          </span>
        ))}
      </>
    );
  }
  if (s.type === 'move') {
    return (
      <>
        <strong>{displayTitle(s.pageTitle)}</strong> <ArrowRight size={13} /> {s.parentTitle ? displayTitle(s.parentTitle) : 'top level'}
      </>
    );
  }
  return (
    <>
      Create <strong>{s.title}</strong>
      {s.parentTitle && <> under {displayTitle(s.parentTitle)}</>} with {s.pageTitles.map(displayTitle).join(', ')}
    </>
  );
}

export function OrganizePage() {
  const [params, setParams] = useSearchParams();
  const kind = (params.get('scope') ?? 'notebook') as ScopeKind;
  const id = params.get('id') ?? '';
  const jobId = params.get('job');
  const notebooks = useNotebooks();
  const pages = usePages();
  const start = useStartOrganize();
  const apply = useApplyOrganize();
  const undo = useUndoBatch();
  const batches = useBatches();
  const job = useJob<OrganizeResult>(jobId);
  const [options, setOptions] = useState({ tags: true, moves: true, groups: kind !== 'page' });
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const scopeTitle =
    kind === 'notebook'
      ? notebooks.data?.find((n) => n.id === id)?.title
      : displayTitle(pages.data?.find((p) => p.id === id)?.title);
  const result = job.data?.status === 'done' ? job.data.result : null;
  const suggestions = useMemo(() => result?.suggestions ?? [], [result]);

  // Everything is preselected; unticking is the exception.
  useEffect(() => setSelected(new Set(suggestions.map((s) => s.id))), [suggestions]);

  const batch = result?.batchId ? batches.data?.find((b) => b.id === result.batchId) : undefined;
  const toggle = (sid: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sid)) next.delete(sid);
      else next.add(sid);
      return next;
    });

  const run = () =>
    start.mutate({ scope: { kind, id }, ...options }, { onSuccess: (j) => setParams({ scope: kind, id, job: j.id }) });

  const what = kind === 'notebook' ? 'notebook' : kind === 'subtree' ? 'page and its subpages' : 'page';

  return (
    <div className="content organize">
      <header className="content-header">
        <h1>
          <Wand2 size={26} /> Organize with AI
        </h1>
        <p className="muted">
          Suggestions for {what} <strong>{scopeTitle ?? '…'}</strong>: tags, better places and new groups. Nothing changes until you
          apply, and applied changes can be undone.
        </p>
      </header>

      {!jobId && (
        <section className="import-card">
          <div className="field">
            <span>Suggest</span>
            <div className="chips">
              {(
                [
                  ['tags', 'Tags'],
                  ['moves', 'Moves'],
                  ['groups', 'New groups'],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="checkbox"
                  aria-checked={options[key]}
                  disabled={key === 'groups' && kind === 'page'}
                  className={options[key] ? 'chip active' : 'chip'}
                  onClick={() => setOptions((o) => ({ ...o, [key]: !o[key] }))}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {start.error && <p className="error">{start.error.message}</p>}
          <div className="import-actions">
            <span />
            <button
              className="btn btn-primary"
              disabled={start.isPending || !id || !(options.tags || options.moves || options.groups)}
              onClick={run}
            >
              <Sparkles size={16} /> Get suggestions
            </button>
          </div>
        </section>
      )}

      {job.data && job.data.status !== 'done' && (
        <section className="import-card">
          <JobProgress job={job.data} />
          {job.data.status !== 'running' && job.data.status !== 'queued' && (
            <button className="btn" onClick={() => setParams({ scope: kind, id })}>
              Try again
            </button>
          )}
        </section>
      )}

      {result && (
        <section className="organize-result">
          <p className="muted">
            {result.pageCount} {result.pageCount === 1 ? 'page' : 'pages'} reviewed · {formatCost(job.data!.cost)}
          </p>

          {suggestions.length === 0 && (
            <div className="empty-state">
              <CheckCircle2 size={28} className="muted" />
              <p className="muted">No suggestions: this looks well organised already.</p>
            </div>
          )}

          {SECTIONS.map(({ type, title, icon: Icon }) => {
            const items = suggestions.filter((s) => s.type === type);
            if (!items.length) return null;
            return (
              <div key={type} className="suggestion-group">
                <h2 className="section-title">
                  <Icon size={14} /> {title}
                </h2>
                <ul className="suggestion-list">
                  {items.map((s) => (
                    <li key={s.id}>
                      <label className={result.batchId ? 'suggestion done' : 'suggestion'}>
                        <input
                          type="checkbox"
                          checked={selected.has(s.id)}
                          disabled={!!result.batchId}
                          onChange={() => toggle(s.id)}
                        />
                        <span className="suggestion-body">
                          <span className="suggestion-text">
                            <SuggestionText s={s} />
                          </span>
                          {s.reason && <span className="suggestion-reason">{s.reason}</span>}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}

          {apply.error && <p className="error">{apply.error.message}</p>}
          {suggestions.length > 0 && (
            <div className="import-actions sticky">
              {result.batchId ? (
                <>
                  <span className="check ok">
                    <CheckCircle2 size={15} /> {batch?.undoneAt ? 'Applied, then undone' : 'Applied'}
                  </span>
                  {!batch?.undoneAt && (
                    <button className="btn" disabled={undo.isPending} onClick={() => undo.mutate(result.batchId!)}>
                      <RotateCcw size={15} /> Undo
                    </button>
                  )}
                </>
              ) : (
                <>
                  <button
                    className="btn"
                    onClick={() =>
                      setSelected(selected.size === suggestions.length ? new Set() : new Set(suggestions.map((s) => s.id)))
                    }
                  >
                    {selected.size === suggestions.length ? 'Select none' : 'Select all'}
                  </button>
                  <button
                    className="btn btn-primary"
                    disabled={!selected.size || apply.isPending}
                    onClick={() => apply.mutate({ jobId: job.data!.id, ids: [...selected] })}
                  >
                    Apply {selected.size} {selected.size === 1 ? 'change' : 'changes'}
                  </button>
                </>
              )}
            </div>
          )}
          <p className="muted">
            {kind === 'notebook' ? (
              <Link to={`/n/${id}`}>Back to the notebook</Link>
            ) : (
              <Link to={`/p/${id}`}>Back to the page</Link>
            )}
          </p>
        </section>
      )}
    </div>
  );
}
