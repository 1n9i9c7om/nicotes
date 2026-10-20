import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ChevronRight, Link2, Loader2, Sparkles, Waypoints } from 'lucide-react';
import { preferredTarget, type AiLinkSuggestion, type OutgoingMention, type SemanticHit } from '@nicotes/shared';
import { plainExcerpt } from '../lib/format';
import { useLinkContext } from '../lib/links';
import { useBacklinks, useLinkMentions, useMentions, useRelated, useSettings, type useSuggestLinks } from '../lib/queries';
import { useLocalState } from '../lib/storage';
import { displayTitle } from '../lib/tree';
import { Excerpt } from './CommandPalette';
import { formatCost } from './JobProgress';

type Tab = 'backlinks' | 'mentions' | 'related' | 'ai';

const LABELS: Record<Tab, string> = {
  backlinks: 'Linked from',
  mentions: 'Unlinked mentions',
  related: 'Related',
  ai: 'AI suggestions',
};

interface Props {
  pageId: string;
  notebookId: string;
  /** Saved version of the open page; mentions are recomputed after every save. */
  version: number;
  /** Turns the first mention in the open page into a link. */
  onLinkHere: (mention: OutgoingMention) => void;
  /** Adds a link to the open page's "See also" section. */
  onSeeAlso: (target: string) => void;
  /** AI link suggestions for the open page; `requested` counts runs, each brings the tab forward. */
  ai: { run: ReturnType<typeof useSuggestLinks>; requested: number };
  /** Turns the suggested phrases in the open page into links. */
  onLinkPhrases: (suggestions: AiLinkSuggestion[]) => void;
}

/**
 * Everything that connects a page to others, under the editor: backlinks, unlinked mentions,
 * related pages and AI link suggestions, one tab at a time so the page end stays calm. Hidden
 * when there is nothing.
 */
export function Connections({ pageId, notebookId, version, onLinkHere, onSeeAlso, ai, onLinkPhrases }: Props) {
  const backlinks = useBacklinks(pageId);
  const mentions = useMentions(pageId, version);
  const settings = useSettings();
  const related = useRelated(pageId, !!settings.data?.semantic.enabled, version);
  const [open, setOpen] = useLocalState('nicotes.backlinksOpen', true);
  const [preferred, setPreferred] = useLocalState<Tab>('nicotes.connectionsTab', 'backlinks');
  const section = useRef<HTMLElement>(null);

  // A new AI run (from the page menu) opens its tab and scrolls it into view.
  useEffect(() => {
    if (!ai.requested) return;
    setPreferred('ai');
    setOpen(true);
    requestAnimationFrame(() => {
      section.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }, [ai.requested]);

  const incoming = mentions.data?.incoming ?? [];
  const outgoing = mentions.data?.outgoing ?? [];
  const similar = related.data?.results ?? [];
  const counts: Record<Tab, number> = {
    backlinks: backlinks.data?.length ?? 0,
    mentions: incoming.length + outgoing.length,
    related: similar.length,
    ai: ai.run.data?.suggestions.length ?? 0,
  };
  const tabs = (Object.keys(counts) as Tab[]).filter((t) => counts[t] > 0 || (t === 'ai' && ai.requested > 0));
  if (!tabs.length) return null;
  const tab = tabs.includes(preferred) ? preferred : tabs[0]!;

  let body: ReactNode = null;
  if (tab === 'backlinks') {
    body = (
      <ul className="backlinks-list">
        {backlinks.data!.map((b) => (
          <li key={b.id}>
            <Link to={`/p/${b.id}`} className="backlink">
              <span className="backlink-title">{displayTitle(b.title)}</span>
              {b.excerpt && <span className="backlink-excerpt">{plainExcerpt(b.excerpt)}</span>}
            </Link>
          </li>
        ))}
      </ul>
    );
  } else if (tab === 'mentions') {
    body = <Mentions pageId={pageId} incoming={incoming} outgoing={outgoing} onLinkHere={onLinkHere} />;
  } else if (tab === 'related') {
    body = <Related hits={similar} notebookId={notebookId} onSeeAlso={onSeeAlso} />;
  } else {
    body = <AiSuggestions key={ai.run.submittedAt} run={ai.run} onLinkPhrases={onLinkPhrases} />;
  }

  return (
    <section ref={section} className="backlinks connections" aria-label="Connections">
      <div className="connections-head">
        <button
          className="icon-btn connections-toggle"
          aria-expanded={open}
          aria-label={open ? 'Collapse connections' : 'Expand connections'}
          onClick={() => setOpen(!open)}
        >
          <ChevronRight size={14} className={open ? 'tree-toggle open' : 'tree-toggle'} />
        </button>
        <div className="connections-tabs" role="tablist">
          {tabs.map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={open && t === tab}
              className={open && t === tab ? 'connections-tab active' : 'connections-tab'}
              onClick={() => {
                setPreferred(t);
                setOpen(true);
              }}
            >
              {t === 'ai' && <Sparkles size={13} />}
              {LABELS[t]}{' '}
              <span className="connections-count">
                {t === 'ai' && ai.run.isPending ? <Loader2 size={11} className="spin" /> : counts[t]}
              </span>
            </button>
          ))}
        </div>
      </div>
      {open && body}
    </section>
  );
}

function Mentions({
  pageId,
  incoming,
  outgoing,
  onLinkHere,
}: {
  pageId: string;
  incoming: NonNullable<ReturnType<typeof useMentions>['data']>['incoming'];
  outgoing: OutgoingMention[];
  onLinkHere: Props['onLinkHere'];
}) {
  const link = useLinkMentions(pageId);
  const busy = (id: string) => link.isPending && link.variables?.includes(id);

  return (
    <div className="mentions">
      {incoming.length > 0 && (
        <div className="mention-group">
          <div className="mention-group-head">
            <span>
              Other pages name this one without linking it
            </span>
            {incoming.length > 1 && (
              <button className="btn btn-sm" disabled={link.isPending} onClick={() => link.mutate(incoming.map((m) => m.id))}>
                <Link2 size={14} /> Link all
              </button>
            )}
          </div>
          <ul className="backlinks-list">
            {incoming.map((m) => (
              <li key={m.id} className="mention-row">
                <Link to={`/p/${m.id}`} className="backlink">
                  <span className="backlink-title">
                    {displayTitle(m.title)}
                    {m.count > 1 && <span className="mention-count"> · {m.count} mentions</span>}
                  </span>
                  <span className="backlink-excerpt">
                    <Excerpt text={m.excerpt} />
                  </span>
                </Link>
                <button
                  className="btn btn-sm"
                  disabled={link.isPending}
                  title="Turn the first mention into a link to this page"
                  onClick={() => link.mutate([m.id])}
                >
                  {busy(m.id) ? <Loader2 size={14} className="spin" /> : <Link2 size={14} />} Link
                </button>
              </li>
            ))}
          </ul>
          {link.error && <p className="error">{link.error.message}</p>}
        </div>
      )}
      {outgoing.length > 0 && (
        <div className="mention-group">
          <div className="mention-group-head">
            <span>This page names other pages — click to link</span>
          </div>
          <ul className="mention-chips">
            {outgoing.map((m) => (
              <li key={m.id}>
                <button
                  className="mention-chip"
                  title={`Link “${m.text}” to ${displayTitle(m.title)}`}
                  onClick={() => onLinkHere(m)}
                >
                  <Link2 size={13} />
                  {m.text}
                  {m.target.toLowerCase() !== m.text.toLowerCase() && (
                    <span className="mention-target">
                      <Waypoints size={11} /> {m.target}
                    </span>
                  )}
                  {m.count > 1 && <span className="mention-target">×{m.count}</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Related({ hits, notebookId, onSeeAlso }: { hits: SemanticHit[]; notebookId: string; onSeeAlso: Props['onSeeAlso'] }) {
  const ctx = useLinkContext();
  return (
    <div className="mentions">
      <div className="mention-group">
        <div className="mention-group-head">
          <span>Similar in meaning, not connected yet</span>
        </div>
        <ul className="backlinks-list">
          {hits.map((r) => {
            const page = ctx.pages.get(r.id);
            return (
              <li key={r.id} className="mention-row">
                <Link to={`/p/${r.id}`} className="backlink">
                  <span className="backlink-title">
                    {displayTitle(r.title)}
                    {r.heading && <span className="mention-count"> › {r.heading}</span>}
                  </span>
                  {r.excerpt && <span className="backlink-excerpt">{plainExcerpt(r.excerpt)}</span>}
                </Link>
                {page && (
                  <button
                    className="btn btn-sm"
                    title="Add a link to this page under “See also”"
                    onClick={() => onSeeAlso(preferredTarget(ctx, page, notebookId))}
                  >
                    <Link2 size={14} /> Link
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function AiSuggestions({ run, onLinkPhrases }: { run: Props['ai']['run']; onLinkPhrases: Props['onLinkPhrases'] }) {
  // Linked suggestions disappear from the list.
  const [done, setDone] = useState<Set<string>>(() => new Set());
  if (run.isPending) {
    return (
      <p className="muted connections-status">
        <Loader2 size={14} className="spin" /> Reading the page and looking for pages it should link to…
      </p>
    );
  }
  if (run.error) return <p className="error connections-status">{run.error.message}</p>;
  if (!run.data) return null;
  const open = run.data.suggestions.filter((s) => !done.has(s.pageId));
  const apply = (list: AiLinkSuggestion[]) => {
    onLinkPhrases(list);
    setDone((d) => new Set([...d, ...list.map((s) => s.pageId)]));
  };

  return (
    <div className="mentions">
      <div className="mention-group">
        <div className="mention-group-head">
          <span>
            {run.data.suggestions.length ? 'Words in this page that could link to other pages' : 'No good link targets found.'} ·{' '}
            {formatCost(run.data.cost)}
          </span>
          {open.length > 1 && (
            <button className="btn btn-sm" onClick={() => apply(open)}>
              <Link2 size={14} /> Link all
            </button>
          )}
        </div>
        {run.data.suggestions.length > 0 && open.length === 0 && <p className="muted connections-status">All linked.</p>}
        <ul className="backlinks-list">
          {open.map((s) => (
            <li key={s.pageId} className="mention-row">
              <Link to={`/p/${s.pageId}`} className="backlink">
                <span className="backlink-title">
                  “{s.phrase}” <span className="mention-count">→ {displayTitle(s.title)}</span>
                </span>
                {s.reason && <span className="backlink-excerpt">{s.reason}</span>}
              </Link>
              <button className="btn btn-sm" title={`Turn “${s.phrase}” into a link`} onClick={() => apply([s])}>
                <Link2 size={14} /> Link
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
