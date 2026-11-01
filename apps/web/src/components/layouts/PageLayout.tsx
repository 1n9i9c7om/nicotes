import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { LayoutTemplate, Loader2, Sparkles, Undo2 } from 'lucide-react';
import { guessLayout, LAYOUT_INFO, LAYOUT_TYPES, pageBlocks, specMatches, type LayoutSpec, type LayoutType } from '@nicotes/shared';
import { useLayoutActions, usePageLayout, useSettings } from '../../lib/queries';
import { aiKeyFor } from '../../lib/ai';
import { formatCost } from '../JobProgress';
import { ChecklistLayout } from './ChecklistLayout';
import { DataLayout } from './DataLayout';
import { DocumentLayout } from './DocumentLayout';
import { GuideLayout } from './GuideLayout';
import { ReaderLayout } from './ReaderLayout';
import { RecipeLayout } from './RecipeLayout';
import type { LayoutProps } from './types';

const VIEWS: Record<LayoutType, ComponentType<LayoutProps>> = {
  document: DocumentLayout,
  checklist: ChecklistLayout,
  recipe: RecipeLayout,
  steps: GuideLayout,
  reader: ReaderLayout,
  data: DataLayout,
};

/** Below this confidence the heuristic asks the AI (once per page and visit). */
const ASK_AI_BELOW = 0.75;

/**
 * The page as an interactive view. The layout comes from the page's stored choice (AI or by
 * hand) or, instantly, from the heuristic; when that is unsure and an API key is set, the AI
 * is asked once. Edits made in the view go through `onChange` and can be undone here.
 */
export function PageLayout({
  pageId,
  notebookId,
  title,
  content,
  tags,
  version,
  onChange,
  flush,
  hideSources,
}: {
  pageId: string;
  notebookId: string;
  title: string;
  content: string;
  tags: string[];
  version: number;
  onChange: (markdown: string) => void;
  /** Saves pending edits (the AI reads the saved page). */
  flush: () => Promise<void>;
  hideSources?: boolean;
}) {
  const settings = useSettings();
  const stored = usePageLayout(pageId, version);
  const actions = useLayoutActions(pageId);
  const blocks = useMemo(() => pageBlocks(content), [content]);
  const auto = useMemo(() => guessLayout(content, tags), [content, tags]);
  const [undo, setUndo] = useState<string[]>([]);
  const asked = useRef(false);
  const apiKeySet = aiKeyFor(settings.data, 'layout', 'Layouts').ready;
  const info = stored.data ?? null;

  // A stored layout whose blocks are gone (the page changed a lot) keeps its type.
  let spec: LayoutSpec = auto;
  if (info) {
    spec = specMatches(info.spec, blocks)
      ? info.spec
      : { ...guessLayout(content, tags, info.spec.type), language: info.spec.language, servings: info.spec.servings };
  }

  const analyze = (type?: LayoutType) => void flush().then(() => actions.analyze.mutate(type));

  useEffect(() => {
    if (asked.current || stored.isPending || info || !apiKeySet) return;
    if (auto.confidence >= ASK_AI_BELOW || content.trim().length < 200) return;
    asked.current = true;
    analyze();
  }, [stored.isPending, info, apiKeySet]);

  const edit = (next: string) => {
    if (next === content) return;
    setUndo((list) => [...list.slice(-29), content]);
    onChange(next);
  };
  const undoLast = () => {
    const previous = undo.at(-1);
    if (previous === undefined) return;
    setUndo((list) => list.slice(0, -1));
    onChange(previous);
  };

  // Ctrl/Cmd+Z undoes the view's own edits (not while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (!typing && (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && undo.length) {
        e.preventDefault();
        undoLast();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const busy = actions.analyze.isPending || actions.choose.isPending || actions.reset.isPending;
  const error = actions.analyze.error ?? actions.choose.error ?? actions.reset.error;
  const changed = info?.stale && !specMatches(info.spec, blocks);
  const source = actions.analyze.isPending
    ? 'Choosing a layout…'
    : !info
      ? 'Detected automatically'
      : info.source === 'ai'
        ? `Chosen by AI${info.cost ? ` · ${formatCost(info.cost)}` : ''}`
        : 'Chosen by you';
  const View = VIEWS[spec.type];

  return (
    <div className="page-layout">
      <div className="layout-bar">
        <LayoutTemplate size={16} className="layout-icon" />
        <select
          className="layout-pick"
          aria-label="Layout"
          value={info ? info.spec.type : ''}
          disabled={busy}
          onChange={(e) => {
            const value = e.target.value as LayoutType | '';
            if (!value) actions.reset.mutate();
            else void flush().then(() => actions.choose.mutate(value));
          }}
        >
          <option value="">Automatic · {LAYOUT_INFO[auto.type].label}</option>
          {LAYOUT_TYPES.map((t) => (
            <option key={t} value={t}>
              {LAYOUT_INFO[t].label}
            </option>
          ))}
        </select>
        <span className="layout-source" title={info?.reason || LAYOUT_INFO[spec.type].hint}>
          {source}
          {changed && ' · page changed since'}
        </span>
        <span className="layout-actions">
          {undo.length > 0 && (
            <button className="btn btn-sm" onClick={undoLast} title="Undo (Ctrl+Z)">
              <Undo2 size={14} /> Undo
            </button>
          )}
          {apiKeySet && (
            <button
              className="btn btn-sm"
              disabled={busy}
              title="Let the AI choose the layout and the parts of the page it shows"
              onClick={() => analyze(info?.source === 'manual' ? info.spec.type : undefined)}
            >
              {actions.analyze.isPending ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}{' '}
              {info?.source === 'ai' && !changed ? 'Ask AI again' : 'Ask AI'}
            </button>
          )}
        </span>
      </div>
      {error && <p className="error layout-error">{error.message}</p>}
      <View
        pageId={pageId}
        notebookId={notebookId}
        title={title}
        markdown={content}
        blocks={blocks}
        spec={spec}
        onChange={edit}
        hideSources={hideSources}
      />
    </div>
  );
}
