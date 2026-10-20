import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Check, FilePlus, Loader2, MessageCircleQuestion, RotateCcw, Send, Sparkles, Square } from 'lucide-react';
import { preferredTarget, type AskEvent, type AskRequest, type AskSource } from '@nicotes/shared';
import { formatCost } from '../components/JobProgress';
import { citedNumbers, renumberCitations } from '../lib/ask';
import { plainExcerpt } from '../lib/format';
import { Markdown } from '../components/Markdown';
import { postStream } from '../lib/api';
import { useLinkContext } from '../lib/links';
import { useCreatePage, useNotebooks, useSettings } from '../lib/queries';
import { useLocalState } from '../lib/storage';
import { displayTitle } from '../lib/tree';

interface Turn {
  id: number;
  question: string;
  answer: string;
  sources: AskSource[];
  retrieval: 'semantic' | 'keyword' | null;
  status: 'searching' | 'answering' | 'done' | 'error';
  error?: string;
  cost?: number;
  savedPageId?: string;
}

export function AskPage() {
  const [params, setParams] = useSearchParams();
  const settings = useSettings();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState('');
  const controller = useRef<AbortController | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const busy = turns.some((t) => t.status === 'searching' || t.status === 'answering');
  const semanticOn = settings.data?.semantic.enabled;

  const update = (id: number, patch: Partial<Turn> | ((t: Turn) => Partial<Turn>)) =>
    setTurns((list) => list.map((t) => (t.id === id ? { ...t, ...(typeof patch === 'function' ? patch(t) : patch) } : t)));

  const ask = async (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    const id = Date.now();
    const history: AskRequest['history'] = turns
      .filter((t) => t.status === 'done')
      .slice(-3)
      .map((t) => ({ question: t.question, answer: t.answer }));
    setTurns((list) => [...list, { id, question: q, answer: '', sources: [], retrieval: null, status: 'searching' }]);
    setQuestion('');
    controller.current = new AbortController();
    try {
      await postStream<AskEvent>(
        '/ai/ask',
        { question: q, history } satisfies AskRequest,
        (event) => {
          if (event.type === 'sources') update(id, { sources: event.sources, retrieval: event.retrieval, status: 'answering' });
          else if (event.type === 'delta') update(id, (t) => ({ answer: t.answer + event.text }));
          else if (event.type === 'done') update(id, { status: 'done', cost: event.cost });
          else update(id, { status: 'error', error: event.message });
        },
        controller.current.signal,
      );
      update(id, (t) => (t.status === 'answering' || t.status === 'searching' ? { status: 'done' } : {}));
    } catch (error) {
      const stopped = (error as Error).name === 'AbortError';
      update(id, (t) => ({ status: stopped && t.answer ? 'done' : 'error', error: stopped ? 'Stopped' : (error as Error).message }));
    }
  };

  // Questions handed over from the search palette (?q=…) are asked right away.
  useEffect(() => {
    const q = params.get('q');
    if (!q) return;
    // Deferred, so a mount/unmount/mount cycle (React's strict mode) asks only once.
    const timer = setTimeout(() => {
      setParams({}, { replace: true });
      void ask(q);
    });
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => () => controller.current?.abort(), []);
  // Braces matter: newer browsers return a Promise from scrollIntoView, which an effect must not return.
  useEffect(() => {
    // The question box is sticky: scrolling it fully into view shows the newest answer above it.
    if (turns.length) form.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [turns.length]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void ask(question);
  };

  return (
    <div className="content ask-page">
      <header className="content-header">
        <h1>
          <MessageCircleQuestion size={26} /> Ask your notes
        </h1>
        <p className="muted">
          Answers come only from your own notes, with numbered sources. Follow-up questions keep the context.
        </p>
      </header>

      {settings.data && !settings.data.openrouter.apiKeySet && (
        <p className="error">Asking needs an OpenRouter API key — add one under Settings.</p>
      )}
      {settings.data && !semanticOn && (
        <p className="ask-hint">
          <Sparkles size={14} /> Answers currently use keyword search.{' '}
          <Link to="/settings#semantic">Switch on the semantic index</Link> to find notes by meaning.
        </p>
      )}

      <div className="ask-turns">
        {turns.map((turn) => (
          <AnswerTurn key={turn.id} turn={turn} onSaved={(pageId) => update(turn.id, { savedPageId: pageId })} />
        ))}
      </div>

      <form ref={form} className="ask-form" onSubmit={submit}>
        <textarea
          rows={2}
          autoFocus
          maxLength={2000}
          placeholder={turns.length ? 'Ask a follow-up…' : 'What do you want to know? E.g. “What did I decide about the home server backups?”'}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="ask-form-actions">
          {turns.length > 0 && !busy && (
            <button type="button" className="btn btn-sm" onClick={() => setTurns([])}>
              <RotateCcw size={14} /> New conversation
            </button>
          )}
          {busy ? (
            <button type="button" className="btn btn-sm" onClick={() => controller.current?.abort()}>
              <Square size={13} /> Stop
            </button>
          ) : (
            <button className="btn btn-primary btn-sm" disabled={!question.trim()}>
              <Send size={14} /> Ask
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

function AnswerTurn({ turn, onSaved }: { turn: Turn; onSaved: (pageId: string) => void }) {
  const [showAll, setShowAll] = useState(false);
  const cited = citedNumbers(turn.answer);
  const byNumber = new Map(turn.sources.map((s) => [s.n, s]));
  const citedSources = cited.map((n) => byNumber.get(n)).filter((s): s is AskSource => !!s);
  const listed = showAll ? turn.sources : citedSources;

  const cite = (n: number, key: string) => {
    const source = byNumber.get(n);
    if (!source) return <sup key={key}>[{n}]</sup>;
    return (
      <Link key={key} to={`/p/${source.pageId}`} className="cite" title={`${displayTitle(source.title)}${source.heading ? ` › ${source.heading}` : ''}`}>
        {n}
      </Link>
    );
  };

  return (
    <article className="ask-turn">
      <p className="ask-question">{turn.question}</p>
      <div className="ask-answer">
        {turn.status === 'searching' && (
          <p className="muted ask-progress">
            <Loader2 size={14} className="spin" /> Searching your notes…
          </p>
        )}
        {turn.status === 'answering' && !turn.answer && (
          <p className="muted ask-progress">
            <Loader2 size={14} className="spin" /> Reading {turn.sources.length} passages…
          </p>
        )}
        {turn.answer && <Markdown text={turn.answer} cite={cite} />}
        {turn.status === 'error' && <p className="error">{turn.error}</p>}
      </div>

      {(turn.status === 'done' || turn.status === 'error') && turn.sources.length > 0 && (
        <div className="ask-sources">
          <div className="ask-sources-head">
            <span>{citedSources.length ? 'Sources' : 'Searched passages'}</span>
            {citedSources.length > 0 && turn.sources.length > citedSources.length && (
              <button className="link-btn" onClick={() => setShowAll(!showAll)}>
                {showAll ? 'Only cited' : `All ${turn.sources.length} passages searched`}
              </button>
            )}
          </div>
          <ol className="ask-source-list">
            {(listed.length ? listed : turn.sources).map((s) => (
              <li key={s.n}>
                <span className="cite static">{s.n}</span>
                <Link to={`/p/${s.pageId}`} className="ask-source">
                  <span className="ask-source-title">
                    {displayTitle(s.title)}
                    {s.heading && <span className="muted"> › {s.heading}</span>}
                  </span>
                  <span className="ask-source-excerpt">{plainExcerpt(s.excerpt)}</span>
                </Link>
              </li>
            ))}
          </ol>
        </div>
      )}

      {turn.status === 'done' && turn.answer && (
        <div className="ask-turn-foot">
          <span className="muted">
            {turn.retrieval === 'keyword' ? 'Keyword search' : 'Found by meaning'}
            {turn.cost !== undefined && ` · ${formatCost(turn.cost)}`}
          </span>
          <SaveAnswer turn={turn} sources={citedSources} onSaved={onSaved} />
        </div>
      )}
    </article>
  );
}

/** Saves an answer as a page, with its cited sources as links at the end. */
function SaveAnswer({ turn, sources, onSaved }: { turn: Turn; sources: AskSource[]; onSaved: (pageId: string) => void }) {
  const notebooks = useNotebooks();
  const ctx = useLinkContext();
  const create = useCreatePage();
  const [lastNotebook, setLastNotebook] = useLocalState<string | null>('nicotes.askNotebook', null);
  const [choosing, setChoosing] = useState(false);
  const fallback = sources[0]?.notebookId ?? notebooks.data?.[0]?.id ?? '';
  const [notebookId, setNotebookId] = useState(
    notebooks.data?.some((n) => n.id === lastNotebook) ? lastNotebook! : fallback,
  );

  if (turn.savedPageId) {
    return (
      <Link to={`/p/${turn.savedPageId}`} className="btn btn-sm">
        <Check size={14} /> Saved · open
      </Link>
    );
  }
  if (!choosing) {
    return (
      <button className="btn btn-sm" onClick={() => setChoosing(true)}>
        <FilePlus size={14} /> Save as note
      </button>
    );
  }

  const save = async () => {
    // Markdown numbers ordered lists itself, so citations are renumbered 1…n in order of use.
    const { answer, list } = renumberCitations(turn.answer, sources, (s) => {
      const page = ctx.pages.get(s.pageId);
      return page ? `[[${preferredTarget(ctx, page, notebookId)}]]${s.heading ? ` › ${s.heading}` : ''}` : displayTitle(s.title);
    });
    const content = `> **Question:** ${turn.question}\n\n${answer.trim()}${list.length ? `\n\n## Sources\n\n${list.join('\n')}` : ''}`;
    const title = turn.question.length > 120 ? `${turn.question.slice(0, 117)}…` : turn.question;
    const page = await create.mutateAsync({ notebookId, parentId: null, title, content });
    setLastNotebook(notebookId);
    onSaved(page.id);
  };

  return (
    <span className="ask-save">
      <select value={notebookId} onChange={(e) => setNotebookId(e.target.value)} aria-label="Notebook">
        {notebooks.data?.map((n) => (
          <option key={n.id} value={n.id}>
            {n.title}
          </option>
        ))}
      </select>
      <button className="btn btn-primary btn-sm" disabled={!notebookId || create.isPending} onClick={() => void save()}>
        Save
      </button>
    </span>
  );
}
