import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Bot, Check, Globe, Loader2, RotateCcw, Send, Square, X } from 'lucide-react';
import {
  READ_SCOPE_INFO,
  READ_SCOPES,
  type AskSource,
  type AssistantEvent,
  type AssistantRequest,
  type ReadScope,
  type WebSource,
} from '@nicotes/shared';
import { postStream } from '../lib/api';
import { aiKeyFor } from '../lib/ai';
import { useApplyChanges, useSettings, useUpdateSettings } from '../lib/queries';
import { useLocalState } from '../lib/storage';
import { displayTitle } from '../lib/tree';
import { DiffReview, hunkStats, useHunkReview } from './DiffReview';
import { formatCost } from './JobProgress';
import { Markdown } from './Markdown';

interface Turn {
  id: number;
  message: string;
  reply: string;
  step: string;
  notes: AskSource[];
  web: WebSource[];
  webError?: string;
  /** The assistant rewrote the page without changing anything. */
  unchanged?: boolean;
  /** The page as the assistant would write it. */
  proposal: string | null;
  /** The page text the request was made with. */
  base: string;
  outcome: { applied: number; total: number } | 'discarded' | null;
  status: 'working' | 'done' | 'error';
  error?: string;
  cost?: number;
}

interface Props {
  pageId: string;
  title: string;
  content: string;
  /** Saves pending edits, so changes are applied on top of what the user sees. */
  flush: () => Promise<void>;
  onClose: () => void;
}

/**
 * Chat about the open page. The assistant may read other notes (within the chosen scope) and
 * the web, but only proposes changes to this page; the user accepts them change by change.
 */
export function PageAssistant({ pageId, title, content, flush, onClose }: Props) {
  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  const scope = settings.data?.assistant.scope ?? 'page';
  const keyCheck = aiKeyFor(settings.data, 'assistant', 'The assistant');
  const [research, setResearch] = useLocalState('nicotes.assistantResearch', false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [message, setMessage] = useState('');
  const controller = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const busy = turns.some((t) => t.status === 'working');

  const update = (id: number, patch: Partial<Turn> | ((t: Turn) => Partial<Turn>)) =>
    setTurns((list) => list.map((t) => (t.id === id ? { ...t, ...(typeof patch === 'function' ? patch(t) : patch) } : t)));

  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [turns]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const text = message.trim();
    if (!text || busy) return;
    const id = Date.now();
    const history: NonNullable<AssistantRequest['history']> = turns
      .filter((t) => t.status === 'done')
      .slice(-5)
      .flatMap((t) => [
        { role: 'user' as const, content: t.message },
        { role: 'assistant' as const, content: (t.reply || '(proposed a change)').slice(0, 8000) },
      ]);
    setTurns((list) => [
      ...list,
      { id, message: text, reply: '', step: '', notes: [], web: [], proposal: null, base: content, outcome: null, status: 'working' },
    ]);
    setMessage('');
    controller.current = new AbortController();
    try {
      await postStream<AssistantEvent>(
        `/ai/pages/${pageId}/assistant`,
        { message: text, title, content, history, scope, research } satisfies AssistantRequest,
        (event) => {
          if (event.type === 'step') update(id, { step: event.text });
          else if (event.type === 'context') update(id, { notes: event.notes, web: event.web, webError: event.webError });
          else if (event.type === 'delta') update(id, (t) => ({ reply: t.reply + event.text }));
          else if (event.type === 'proposal') update(id, { proposal: event.content });
          else if (event.type === 'done') update(id, { status: 'done', cost: event.cost, unchanged: event.unchanged });
          else update(id, { status: 'error', error: event.message });
        },
        controller.current.signal,
      );
      update(id, (t) => (t.status === 'working' ? { status: 'done' } : {}));
    } catch (error) {
      const stopped = (error as Error).name === 'AbortError';
      update(id, { status: 'error', error: stopped ? 'Stopped' : (error as Error).message });
    }
  };

  return (
    <aside className="assistant" aria-label="Page assistant">
      <header className="assistant-head">
        <h2>
          <Bot size={16} /> Assistant
        </h2>
        {turns.length > 0 && !busy && (
          <button className="icon-btn" aria-label="New conversation" title="New conversation" onClick={() => setTurns([])}>
            <RotateCcw size={15} />
          </button>
        )}
        <button className="icon-btn" aria-label="Close assistant" onClick={onClose}>
          <X size={16} />
        </button>
      </header>

      <div className="assistant-options">
        <label className="assistant-scope" title={READ_SCOPE_INFO[scope].hint}>
          <span>Reads</span>
          <select
            value={scope}
            aria-label="Notes the assistant may read"
            onChange={(e) => updateSettings.mutate({ assistantScope: e.target.value as ReadScope })}
          >
            {READ_SCOPES.map((s) => (
              <option key={s} value={s}>
                {READ_SCOPE_INFO[s].label}
              </option>
            ))}
          </select>
        </label>
        <button
          className={`chip${research ? ' active' : ''}`}
          aria-pressed={research}
          title="Search the web and read a few sources before answering"
          onClick={() => setResearch(!research)}
        >
          <Globe size={13} /> Web research
        </button>
      </div>

      <div className="assistant-turns">
        {turns.length === 0 && (
          <div className="assistant-empty muted">
            <p>Ask about this page or tell the assistant what to change: “Summarize this”, “Add a section on costs”, “Fix spelling”.</p>
            <p>It only ever changes this page, and only the changes you accept. {READ_SCOPE_INFO[scope].hint}</p>
          </div>
        )}
        {turns.map((turn) => (
          <TurnView
            key={turn.id}
            turn={turn}
            content={content}
            pageId={pageId}
            flush={flush}
            onOutcome={(outcome) => update(turn.id, { outcome })}
          />
        ))}
        <div ref={end} />
      </div>

      {keyCheck.message && <p className="error assistant-note">{keyCheck.message}</p>}
      <form className="assistant-form" onSubmit={send}>
        <textarea
          rows={3}
          maxLength={4000}
          placeholder="Ask or request a change…"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        {busy ? (
          <button type="button" className="btn btn-sm" onClick={() => controller.current?.abort()}>
            <Square size={13} /> Stop
          </button>
        ) : (
          <button className="btn btn-primary btn-sm" disabled={!message.trim()} aria-label="Send">
            <Send size={14} />
          </button>
        )}
      </form>
    </aside>
  );
}

interface TurnProps {
  turn: Turn;
  content: string;
  pageId: string;
  flush: () => Promise<void>;
  onOutcome: (outcome: Turn['outcome']) => void;
}

function TurnView({ turn, content, pageId, flush, onOutcome }: TurnProps) {
  const notes = new Map(turn.notes.map((n) => [n.n, n]));
  const web = new Map(turn.web.map((w) => [w.n, w]));
  // Web citations ([W2]) become links to the source.
  const reply = turn.reply.replace(/\[W(\d+)\]/g, (whole, n: string) => {
    const source = web.get(Number(n));
    return source ? `[W${n}](${source.url})` : whole;
  });
  const cite = (n: number, key: string) => {
    const note = notes.get(n);
    if (!note) return <sup key={key}>[{n}]</sup>;
    return (
      <Link key={key} to={`/p/${note.pageId}`} className="cite" title={`${displayTitle(note.title)}${note.heading ? ` › ${note.heading}` : ''}`}>
        {n}
      </Link>
    );
  };
  const read = [
    turn.notes.length ? `${turn.notes.length} ${turn.notes.length === 1 ? 'note passage' : 'note passages'}` : '',
    turn.web.length ? `${turn.web.length} web ${turn.web.length === 1 ? 'source' : 'sources'}` : '',
  ].filter(Boolean);

  return (
    <article className="assistant-turn">
      <p className="assistant-message">{turn.message}</p>
      <div className="assistant-reply">
        {turn.status === 'working' && !turn.reply && (
          <p className="muted assistant-step">
            <Loader2 size={13} className="spin" /> {turn.step || 'Thinking…'}
          </p>
        )}
        {reply && <Markdown text={reply} cite={cite} />}
        {turn.status === 'working' && turn.reply && (
          <p className="muted assistant-step">
            <Loader2 size={13} className="spin" /> Drafting…
          </p>
        )}
        {turn.status === 'error' && <p className="error">{turn.error}</p>}
      </div>
      {turn.webError && <p className="assistant-outcome warning">{turn.webError}</p>}
      {turn.unchanged && <p className="assistant-outcome muted">The page came back unchanged — nothing to apply.</p>}
      {turn.proposal !== null && turn.status !== 'working' && (
        <Proposal turn={turn} content={content} pageId={pageId} flush={flush} onOutcome={onOutcome} />
      )}
      {turn.status === 'done' && (read.length > 0 || turn.cost !== undefined) && (
        <p className="assistant-foot muted">
          {read.length > 0 && <span>Read {read.join(' and ')}</span>}
          {turn.web.map((w) => (
            <a key={w.n} href={w.url} target="_blank" rel="noreferrer" title={w.title}>
              W{w.n}
            </a>
          ))}
          {turn.cost !== undefined && <span>{formatCost(turn.cost)}</span>}
        </p>
      )}
    </article>
  );
}

function Proposal({ turn, content, pageId, flush, onOutcome }: TurnProps) {
  const review = useHunkReview(content, turn.proposal!);
  const apply = useApplyChanges(pageId);
  const stats = hunkStats(review.hunks);
  const count = review.accepted.size;

  if (turn.outcome === 'discarded') return <p className="assistant-outcome muted">Changes discarded.</p>;
  if (turn.outcome) {
    return (
      <p className="assistant-outcome">
        <Check size={14} /> Applied {turn.outcome.applied === turn.outcome.total ? 'all' : `${turn.outcome.applied} of ${turn.outcome.total}`}{' '}
        {turn.outcome.total === 1 ? 'change' : 'changes'} · undo from the version history
      </p>
    );
  }
  if (!review.hunks.length) return <p className="assistant-outcome muted">The page already contains these changes.</p>;

  const accept = async () => {
    await flush();
    await apply.mutateAsync({ content: review.result(), reason: 'assistant' });
    onOutcome({ applied: count, total: review.hunks.length });
  };

  return (
    <div className="assistant-proposal">
      <div className="assistant-proposal-head">
        <strong>Proposed changes</strong>
        <span className="diff-hunk-stats">
          <span className="plus">+{stats.added}</span>
          <span className="minus">−{stats.removed}</span>
        </span>
        {review.hunks.length > 1 && (
          <span className="assistant-pick">
            <button className="link-btn" onClick={review.all}>
              All
            </button>
            <button className="link-btn" onClick={review.none}>
              None
            </button>
          </span>
        )}
      </div>
      {content !== turn.base && (
        <p className="muted assistant-note">The page changed since; the changes are compared with its current text.</p>
      )}
      <DiffReview
        className="diff-compact"
        label="Proposed changes to this page"
        before={content}
        hunks={review.hunks}
        accepted={review.accepted}
        onToggle={review.toggle}
        context={2}
      />
      {apply.error && <p className="error">{apply.error.message}</p>}
      <div className="assistant-proposal-actions">
        <button className="btn btn-sm" onClick={() => onOutcome('discarded')}>
          Discard
        </button>
        <button className="btn btn-primary btn-sm" disabled={count === 0 || apply.isPending} onClick={() => void accept()}>
          {apply.isPending ? <Loader2 size={14} className="spin" /> : <Check size={14} />}{' '}
          {count === review.hunks.length ? 'Apply' : `Apply ${count} of ${review.hunks.length}`}
        </button>
      </div>
    </div>
  );
}
