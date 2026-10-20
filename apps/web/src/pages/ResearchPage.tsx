import { useMemo, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ArrowRight, FileText, Settings as SettingsIcon, Telescope } from 'lucide-react';
import { RESEARCH_DEPTHS, type Job, type ResearchDepth, type ResearchRequest, type ResearchResult } from '@nicotes/shared';
import { formatCost, JobProgress } from '../components/JobProgress';
import { timeAgo } from '../lib/format';
import { useJob, useJobs, useNotebooks, usePages, useSettings, useStartResearch } from '../lib/queries';
import { useLocalState } from '../lib/storage';
import { buildTree, displayTitle, rootKey, type PageTree } from '../lib/tree';

function flatten(tree: PageTree, notebookId: string) {
  const out: { id: string; title: string; depth: number }[] = [];
  const walk = (key: string, depth: number) => {
    for (const page of tree.children.get(key) ?? []) {
      out.push({ id: page.id, title: displayTitle(page.title), depth });
      walk(page.id, depth + 1);
    }
  };
  walk(rootKey(notebookId), 0);
  return out;
}

export function ResearchPage() {
  const [params, setParams] = useSearchParams();
  const notebooks = useNotebooks();
  const pages = usePages();
  const settings = useSettings();
  const start = useStartResearch();
  const history = useJobs('research');
  const [question, setQuestion] = useState('');
  const [depth, setDepth] = useLocalState<ResearchDepth>('nicotes.researchDepth', 'standard');
  const [lastNotebook, setLastNotebook] = useLocalState<string | null>('nicotes.researchNotebook', null);
  const [notebookId, setNotebookId] = useState<string | null>(null);
  const [parentId, setParentId] = useState<string | null>(null);

  const jobId = params.get('job');
  const job = useJob<ResearchResult>(jobId);
  const tree = useMemo(() => buildTree(pages.data ?? []), [pages.data]);
  const target = notebooks.data?.find((n) => n.id === (notebookId ?? lastNotebook)) ?? notebooks.data?.[0];
  const parents = target ? flatten(tree, target.id) : [];
  const ai = settings.data?.ai;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!target) return;
    const input: ResearchRequest = { question, depth, notebookId: target.id, parentId };
    start.mutate(input, {
      onSuccess: (j) => {
        setLastNotebook(target.id);
        setParams({ job: j.id });
      },
    });
  };

  const active = job.data && (job.data.status === 'queued' || job.data.status === 'running');
  const result = job.data?.status === 'done' ? job.data.result : null;
  // Runs outlive their notes: a deleted note must not be linked as if it still existed.
  const live = useMemo(() => new Set((pages.data ?? []).map((p) => p.id)), [pages.data]);
  const isDeleted = (r: ResearchResult | null) => !!r && !!pages.data && !live.has(r.pageId);

  return (
    <div className="content research">
      <header className="content-header">
        <h1>
          <Telescope size={26} /> Research
        </h1>
        <p className="muted">
          Ask a question; Nicotes searches the web, reads the best sources and writes a note with citations.
        </p>
      </header>

      {job.data && (
        <section className="import-card">
          <p className="research-question">“{(job.data.input as ResearchRequest).question}”</p>
          <JobProgress job={job.data} />
          {result && (
            <div className="import-actions">
              <span className="muted">
                {result.sources} sources via {result.searchProvider === 'searxng' ? 'SearXNG' : 'OpenRouter web search'}
              </span>
              {isDeleted(result) ? (
                <span className="muted">
                  “{result.title}” was deleted. <Link to="/trash">Restore it from the trash</Link>
                </span>
              ) : (
                <Link className="btn btn-primary" to={`/p/${result.pageId}`}>
                  Open “{result.title}” <ArrowRight size={15} />
                </Link>
              )}
            </div>
          )}
          {!active && (
            <button className="btn" onClick={() => setParams({})}>
              New question
            </button>
          )}
        </section>
      )}

      {!jobId && (
        <form className="import-card" onSubmit={submit}>
          <textarea
            className="import-text"
            required
            autoFocus
            minLength={3}
            rows={3}
            placeholder="What would you like to know? E.g. “Which Elden Ring weapons scale best with strength?”"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) e.currentTarget.form?.requestSubmit();
            }}
          />
          <div className="field">
            <span>Depth</span>
            <div className="chips" role="radiogroup">
              {(Object.keys(RESEARCH_DEPTHS) as ResearchDepth[]).map((d) => (
                <button
                  key={d}
                  type="button"
                  role="radio"
                  aria-checked={depth === d}
                  className={depth === d ? 'chip active' : 'chip'}
                  onClick={() => setDepth(d)}
                >
                  {RESEARCH_DEPTHS[d].label} · {RESEARCH_DEPTHS[d].sources} sources
                </button>
              ))}
            </div>
          </div>
          <div className="import-target">
            <label className="field">
              <span>Save in notebook</span>
              <select
                value={target?.id ?? ''}
                onChange={(e) => {
                  setNotebookId(e.target.value);
                  setParentId(null);
                }}
              >
                {notebooks.data?.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Inside page</span>
              <select value={parentId ?? ''} onChange={(e) => setParentId(e.target.value || null)}>
                <option value="">— Top level —</option>
                {parents.map((p) => (
                  <option key={p.id} value={p.id}>
                    {' '.repeat(p.depth)}
                    {p.title}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {start.error && <p className="error">{start.error.message}</p>}
          <div className="import-actions">
            <span className="muted research-meta">
              {ai && (
                <>
                  {ai.researchModel} · {ai.searxngUrl ? 'SearXNG' : 'OpenRouter web search'} · limit {formatCost(ai.costLimit)}{' '}
                  <Link to="/settings" aria-label="AI settings">
                    <SettingsIcon size={13} />
                  </Link>
                </>
              )}
            </span>
            <button className="btn btn-primary" disabled={!target || start.isPending || !question.trim()}>
              <Telescope size={16} /> Start research
            </button>
          </div>
          {!settings.data?.openrouter.apiKeySet && (
            <p className="error">Research needs an OpenRouter API key — add one under Settings.</p>
          )}
        </form>
      )}

      {!!history.data?.length && (
        <section className="section">
          <h2 className="section-title">Recent research</h2>
          <ul className="recent-list">
            {history.data.map((j) => (
              <RecentResearch
                key={j.id}
                job={j}
                deleted={isDeleted(j.result as ResearchResult | null)}
                onOpen={() => setParams({ job: j.id })}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function RecentResearch({ job, deleted, onOpen }: { job: Job; deleted: boolean; onOpen: () => void }) {
  const result = job.result as ResearchResult | null;
  const input = job.input as ResearchRequest;
  return (
    <li>
      <button className={deleted ? 'recent-item research-item deleted' : 'recent-item research-item'} onClick={onOpen}>
        <FileText size={16} className="muted" />
        <span className="recent-title">{result?.title ?? input.question}</span>
        <span className="recent-meta">
          {deleted ? 'deleted' : job.status === 'done' ? `${result?.sources} sources` : job.status} · {formatCost(job.cost)}
        </span>
        <span className="recent-time">{timeAgo(job.createdAt)}</span>
      </button>
    </li>
  );
}
