import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronRight,
  CloudOff,
  Code2,
  Eye,
  EyeOff,
  FolderInput,
  Globe,
  History,
  LayoutTemplate,
  Link2,
  Loader2,
  Printer,
  Sparkles,
  Wand2,
  Waypoints,
  X,
} from 'lucide-react';
import {
  appendSeeAlso,
  hasCitations,
  isCanvas,
  findPhrase,
  linkFirstMention,
  linkMention,
  type AiLinkSuggestion,
  type OutgoingMention,
  type Page,
} from '@nicotes/shared';
import { useAutosave, type SaveStatus } from '../editor/useAutosave';
import { VisualEditor, type EditorHandle } from '../editor/VisualEditor';
import { Connections } from '../components/Connections';
import { PageAssistant } from '../components/PageAssistant';
import { PageSummary } from '../components/PageSummary';
import { PageWidthHandles } from '../components/PageWidthHandles';
import { LocalGraph } from '../components/graph/LocalGraph';
import { HistoryDialog } from '../components/HistoryDialog';
import { PageLayout } from '../components/layouts/PageLayout';
import { Menu } from '../components/Menu';
import { MoveDialog } from '../components/MoveDialog';
import { ShareDialog } from '../components/ShareDialog';
import { TagEditor } from '../components/TagEditor';
import { ApiError, uploadFile } from '../lib/api';
import { useLinkBridge } from '../lib/links';
import { linksShowing, useShares } from '../lib/shares';
import { useLocalState } from '../lib/storage';
import {
  useApplyChanges,
  useLoadEmbed,
  useNotebooks,
  usePage,
  usePages,
  useRenamePage,
  useSuggestLinks,
  useSummarize,
  useTags,
} from '../lib/queries';
import { inheritedTagMap } from '../lib/tags';
import { ancestors, buildTree, displayTitle } from '../lib/tree';
import { loadCanvasEditor } from '../lib/excalidraw';
import { printPage } from '../lib/print';
import { NotFound } from './NotFound';

// Excalidraw is large: canvas pages load it on demand.
const CanvasEditor = lazy(loadCanvasEditor);

type Mode = 'visual' | 'source';
/** Navigation state set when a page was just created: open it directly and focus the title. */
type NavState = { created?: Page };

// CodeMirror is only needed in Markdown mode, so it loads on demand.
const SourceEditor = lazy(() => import('../editor/SourceEditor').then((m) => ({ default: m.SourceEditor })));

export function PageView() {
  const { pageId = '' } = useParams();
  const location = useLocation();
  const page = usePage(pageId, (location.state as NavState | null)?.created);

  if (page.isPending) return <div className="content-loading" aria-busy="true" />;
  if (page.error instanceof ApiError && page.error.status === 404) return <NotFound />;
  if (page.isError) return <div className="empty-state"><p className="error">{page.error.message}</p></div>;
  // Keyed by id so editor state and autosave are fresh for every page.
  return <PageEditor key={page.data.id} page={page.data} />;
}

function PageEditor({ page }: { page: Page }) {
  const location = useLocation();
  const navigate = useNavigate();
  const notebooks = useNotebooks();
  const pages = usePages();
  const rename = useRenamePage();
  const { content, setContent, replaceContent, status, conflict, resolveConflict, revision, flush } = useAutosave(page);
  const saved = usePage(page.id);
  const version = saved.data?.version ?? page.version;
  const summarize = useSummarize(page.id);
  const suggest = useSuggestLinks(page.id);
  const [suggestRuns, setSuggestRuns] = useState(0);
  const [mode, setMode] = useLocalState<Mode>('nicotes.editorMode', 'visual');
  // The interactive view is remembered per page (a recipe opens in cook view, notes in the editor).
  const [viewPages, setViewPages] = useLocalState<string[]>('nicotes.viewPages', []);
  const viewing = viewPages.includes(page.id);
  // A drawing rather than text: shown by the canvas editor, without the text tools.
  const canvas = isCanvas(content);
  const showView = (on: boolean) =>
    setViewPages((list) => (on ? [...list.filter((id) => id !== page.id), page.id].slice(-500) : list.filter((id) => id !== page.id)));
  const editIn = (next: Mode) => {
    setMode(next);
    showView(false);
  };
  const [title, setTitle] = useState(page.title);
  const editor = useRef<EditorHandle>(null);
  const titleInput = useRef<HTMLTextAreaElement>(null);
  const body = useRef<HTMLDivElement>(null);
  // Per device, as the right width depends on the screen; null = the default width.
  const [pageWidth, setPageWidth] = useLocalState<number | null>('nicotes.pageWidth', null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [assistantOpen, setAssistantOpen] = useLocalState('nicotes.assistantOpen', false);
  // Purely visual: source citations ("gooey 2, 3, 7.") are hidden, the text keeps them.
  const [hideSources, setHideSources] = useLocalState('nicotes.hideSources', false);
  const cited = useMemo(() => hasCitations(content), [content]);
  const applyChanges = useApplyChanges(page.id);
  const tree = useMemo(() => buildTree(pages.data ?? []), [pages.data]);
  const summary = tree.byId.get(page.id);
  // The page may be moved while open ("Move to…"); the tree has its current notebook.
  const notebookId = summary?.notebookId ?? page.notebookId;
  const bridge = useLinkBridge(notebookId);
  const upload = useCallback((file: File) => uploadFile(file, page.id), [page.id]);
  const onUploadError = useCallback((error: Error) => setUploadError(error.message), []);
  const loadPage = useLoadEmbed();
  const env = { bridge, upload, onUploadError, loadPage };

  const tagList = useTags();
  const inherited = useMemo(
    () =>
      (inheritedTagMap(pages.data ?? [], tagList.data ?? []).get(page.id) ?? []).map((t) => ({
        name: t.name,
        from: displayTitle(tree.byId.get(t.fromId)?.title),
      })),
    [pages.data, tagList.data, page.id, tree],
  );
  const notebook = notebooks.data?.find((n) => n.id === notebookId);
  const trail = ancestors(tree, page.id);
  const shares = useShares();
  const sharedBy = linksShowing(shares.data ?? [], { id: page.id, notebookId }, trail.map((p) => p.id));

  const linkHere = (mention: OutgoingMention) => {
    const next = linkFirstMention(content, mention.title, mention.target);
    if (next !== null) replaceContent(next);
  };
  const linkPhrases = (suggestions: AiLinkSuggestion[]) => {
    let next = content;
    for (const s of suggestions) {
      const found = findPhrase(next, s.phrase);
      if (found) next = linkMention(next, found, s.target);
    }
    if (next !== content) replaceContent(next);
  };
  // The server reads the saved text, so unsaved edits are flushed first.
  const suggestLinks = async () => {
    await flush();
    setSuggestRuns((n) => n + 1);
    suggest.mutate();
  };

  // Keep the title in sync when it is renamed from the sidebar.
  const treeTitle = tree.byId.get(page.id)?.title;
  useEffect(() => {
    if (treeTitle !== undefined && document.activeElement !== titleInput.current) setTitle(treeTitle);
  }, [treeTitle]);

  // Debounced title save.
  useEffect(() => {
    if (title.trim() === (treeTitle ?? page.title)) return;
    const timer = setTimeout(() => rename.mutate({ id: page.id, title: title.trim() }), 500);
    return () => clearTimeout(timer);
  }, [title]);

  useEffect(() => {
    if ((location.state as NavState | null)?.created?.id !== page.id) return;
    titleInput.current?.focus();
    // Drop the handed-over copy from history so Back/Forward later loads fresh data.
    navigate(location.pathname, { replace: true, state: null });
  }, [location.state]);

  // Ctrl+P prints the page the way the menu does (a canvas needs preparing first).
  const print = () => void printPage(displayTitle(title));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        print();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Auto-grow the title textarea.
  useEffect(() => {
    const el = titleInput.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [title]);

  // Ctrl/Cmd+S saves immediately instead of opening the browser's save dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void flush();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flush]);

  return (
    <div className="page">
      <div className="page-bar">
        <nav className="breadcrumb" aria-label="Breadcrumb">
          {notebook && (
            <Link to={`/n/${notebook.id}`} className="crumb">
              <span className="notebook-dot" style={{ background: notebook.color ?? 'var(--accent)' }} />
              {notebook.title}
            </Link>
          )}
          {trail.map((p) => (
            <span key={p.id} className="crumb-wrap">
              <ChevronRight size={14} className="crumb-sep" />
              <Link to={`/p/${p.id}`} className="crumb">
                {displayTitle(p.title)}
              </Link>
            </span>
          ))}
        </nav>
        <div className="page-bar-actions">
          <SaveIndicator status={status} />
          {sharedBy.length > 0 && (
            <button
              className="btn btn-sm shared-toggle"
              title="Anyone with a link can read this page"
              onClick={() => setSharing(true)}
            >
              <Globe size={15} /> <span>Shared</span>
            </button>
          )}
          <Menu
            label="Page actions"
            items={[
              { label: 'Version history', icon: <History size={15} />, onSelect: () => setHistoryOpen(true) },
              { label: 'Show in graph', icon: <Waypoints size={15} />, onSelect: () => navigate(`/graph?focus=${page.id}&depth=2`) },
              { label: 'Move to…', icon: <FolderInput size={15} />, onSelect: () => setMoving(true) },
              { label: 'Share…', icon: <Globe size={15} />, onSelect: () => setSharing(true) },
              { label: 'Print or save as PDF', icon: <Printer size={15} />, onSelect: print },
              {
                label: 'Summarize with AI',
                icon: <Sparkles size={15} />,
                onSelect: () => void flush().then(() => summarize.mutate()),
              },
              { label: 'Suggest links with AI', icon: <Link2 size={15} />, onSelect: () => void suggestLinks() },
              {
                label: 'Organize with AI',
                icon: <Wand2 size={15} />,
                onSelect: () =>
                  navigate(`/organize?scope=${tree.children.get(page.id)?.length ? 'subtree' : 'page'}&id=${page.id}`),
              },
            ]}
          />
          {!canvas && cited && (viewing || mode === 'visual') && (
            <button
              className={`btn btn-sm sources-toggle${hideSources ? ' active' : ''}`}
              aria-pressed={hideSources}
              title={hideSources ? 'Show the source numbers in the text' : 'Hide the source numbers in the text (the page keeps them)'}
              onClick={() => setHideSources(!hideSources)}
            >
              <EyeOff size={15} /> <span>Hide sources</span>
            </button>
          )}
          {!canvas && (
            <button
              className={`btn btn-sm assistant-toggle${assistantOpen ? ' active' : ''}`}
              aria-pressed={assistantOpen}
              title="Chat about this page and let AI propose changes"
              onClick={() => setAssistantOpen(!assistantOpen)}
            >
              <Bot size={15} /> <span>Assistant</span>
            </button>
          )}
          {!canvas && <div className="segmented" role="group" aria-label="Editor mode">
            <button
              className={!viewing && mode === 'visual' ? 'active' : ''}
              aria-pressed={!viewing && mode === 'visual'}
              onClick={() => editIn('visual')}
            >
              <Eye size={15} /> <span>Visual</span>
            </button>
            <button
              className={!viewing && mode === 'source' ? 'active' : ''}
              aria-pressed={!viewing && mode === 'source'}
              onClick={() => editIn('source')}
            >
              <Code2 size={15} /> <span>Markdown</span>
            </button>
            <button
              className={viewing ? 'active' : ''}
              aria-pressed={viewing}
              title="Interactive view: checklist, recipe, guide or reader"
              onClick={() => showView(true)}
            >
              <LayoutTemplate size={15} /> <span>View</span>
            </button>
          </div>}
        </div>
      </div>

      {uploadError && (
        <div className="banner banner-warning" role="alert">
          <AlertTriangle size={18} />
          <span>Upload failed: {uploadError}</span>
          <button className="icon-btn" aria-label="Dismiss" onClick={() => setUploadError(null)}>
            <X size={16} />
          </button>
        </div>
      )}

      {conflict && (
        <div className="banner banner-warning" role="alert">
          <AlertTriangle size={18} />
          <span>This page was changed in another tab or device.</span>
          <button className="btn btn-sm" onClick={() => resolveConflict('theirs')}>
            Load their version
          </button>
          <button className="btn btn-sm btn-danger" onClick={() => resolveConflict('mine')}>
            Keep mine
          </button>
        </div>
      )}

      <div className="page-split">
        <div className="page-main">
          <div
            ref={body}
            className={`page-body${hideSources ? ' hide-sources' : ''}${canvas ? ' canvas-body' : ''}`}
            style={pageWidth && !canvas ? { maxWidth: pageWidth } : undefined}
          >
            {!canvas && <PageWidthHandles body={body} width={pageWidth} onChange={setPageWidth} />}
            <h1 className="print-title">{displayTitle(title)}</h1>
            <textarea
              ref={titleInput}
              className="page-title"
              rows={1}
              placeholder="Untitled"
              value={title}
              maxLength={300}
              aria-label="Page title"
              onChange={(e) => setTitle(e.target.value.replace(/\n/g, ''))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || (e.key === 'ArrowDown' && e.currentTarget.selectionStart === title.length)) {
                  e.preventDefault();
                  editor.current?.focus();
                }
              }}
            />
            <TagEditor pageId={page.id} tags={summary?.tags ?? page.tags} inherited={inherited} />
            {!canvas && <PageSummary pageId={page.id} version={version} summarize={summarize} />}
            {canvas ? (
              <Suspense fallback={<div className="canvas-host canvas-loading" aria-busy="true" />}>
                <CanvasEditor key={`c${revision}`} content={content} onChange={setContent} upload={upload} onOpenLink={(t) => bridge.open(t)} />
              </Suspense>
            ) : viewing ? (
              <PageLayout
                pageId={page.id}
                notebookId={notebookId}
                title={title}
                content={content}
                tags={summary?.tags ?? page.tags}
                version={version}
                onChange={replaceContent}
                flush={flush}
                hideSources={hideSources}
              />
            ) : mode === 'visual' ? (
              <VisualEditor key={`v${revision}`} ref={editor} initialContent={content} onChange={setContent} {...env} />
            ) : (
              <Suspense fallback={null}>
                <SourceEditor key={`s${revision}`} ref={editor} value={content} onChange={setContent} {...env} />
              </Suspense>
            )}
            <Connections
              pageId={page.id}
              notebookId={notebookId}
              version={version}
              onLinkHere={linkHere}
              onSeeAlso={(target) => replaceContent(appendSeeAlso(content, target))}
              ai={{ run: suggest, requested: suggestRuns }}
              onLinkPhrases={linkPhrases}
            />
            <LocalGraph pageId={page.id} notebookId={notebookId} />
          </div>
        </div>
        {assistantOpen && !canvas && (
          <PageAssistant
            pageId={page.id}
            title={title}
            content={content}
            flush={flush}
            onClose={() => setAssistantOpen(false)}
          />
        )}
      </div>

      {moving && summary && <MoveDialog page={summary} onClose={() => setMoving(false)} />}
      {sharing && (
        <ShareDialog
          kind="page"
          targetId={page.id}
          title={displayTitle(title)}
          hasChildren={(tree.children.get(page.id)?.length ?? 0) > 0}
          inherited={sharedBy
            .filter((s) => s.targetId !== page.id)
            .map((share) => ({ share, title: share.kind === 'notebook' ? (notebook?.title ?? '') : displayTitle(tree.byId.get(share.targetId)?.title) }))}
          onClose={() => setSharing(false)}
        />
      )}
      {historyOpen && (
        <HistoryDialog
          pageId={page.id}
          currentContent={content}
          onApply={async (text) => {
            await flush();
            await applyChanges.mutateAsync({ content: text, reason: 'restore' });
          }}
          onClose={() => setHistoryOpen(false)}
        />
      )}
    </div>
  );
}

function SaveIndicator({ status }: { status: SaveStatus }) {
  const map: Record<SaveStatus, { icon: ReactNode; label: string }> = {
    saved: { icon: <Check size={14} />, label: 'Saved' },
    dirty: { icon: <span className="dot" />, label: 'Editing' },
    saving: { icon: <Loader2 size={14} className="spin" />, label: 'Saving…' },
    error: { icon: <CloudOff size={14} />, label: 'Offline – retrying' },
    conflict: { icon: <AlertTriangle size={14} />, label: 'Conflict' },
    local: { icon: <CloudOff size={14} />, label: 'Saved on this device' },
  };
  const { icon, label } = map[status];
  return (
    <span className={`save-status status-${status}`} role="status" aria-live="polite">
      {icon}
      <span>{label}</span>
    </span>
  );
}
