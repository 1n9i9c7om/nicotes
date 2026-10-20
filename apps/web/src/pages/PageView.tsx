import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { AlertTriangle, Check, ChevronRight, CloudOff, Code2, Eye, FolderInput, History, Loader2, X } from 'lucide-react';
import type { Page } from '@nicotes/shared';
import { useAutosave, type SaveStatus } from '../editor/useAutosave';
import { VisualEditor, type EditorHandle } from '../editor/VisualEditor';
import { Backlinks } from '../components/Backlinks';
import { HistoryDialog } from '../components/HistoryDialog';
import { Menu } from '../components/Menu';
import { MoveDialog } from '../components/MoveDialog';
import { TagEditor } from '../components/TagEditor';
import { ApiError, uploadFile } from '../lib/api';
import { useLinkBridge } from '../lib/links';
import { useLocalState } from '../lib/storage';
import { useNotebooks, usePage, usePages, useRenamePage } from '../lib/queries';
import { ancestors, buildTree, displayTitle } from '../lib/tree';
import { NotFound } from './NotFound';

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
  const { content, setContent, status, conflict, resolveConflict, revision, flush } = useAutosave(page);
  const [mode, setMode] = useLocalState<Mode>('nicotes.editorMode', 'visual');
  const [title, setTitle] = useState(page.title);
  const editor = useRef<EditorHandle>(null);
  const titleInput = useRef<HTMLTextAreaElement>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const bridge = useLinkBridge(page.notebookId);
  const upload = useCallback((file: File) => uploadFile(file, page.id), [page.id]);
  const onUploadError = useCallback((error: Error) => setUploadError(error.message), []);
  const env = { bridge, upload, onUploadError };

  const tree = useMemo(() => buildTree(pages.data ?? []), [pages.data]);
  const summary = tree.byId.get(page.id);
  const notebook = notebooks.data?.find((n) => n.id === page.notebookId);
  const trail = ancestors(tree, page.id);

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
          <Menu
            label="Page actions"
            items={[
              { label: 'Version history', icon: <History size={15} />, onSelect: () => setHistoryOpen(true) },
              { label: 'Move to…', icon: <FolderInput size={15} />, onSelect: () => setMoving(true) },
            ]}
          />
          <div className="segmented" role="group" aria-label="Editor mode">
            <button className={mode === 'visual' ? 'active' : ''} aria-pressed={mode === 'visual'} onClick={() => setMode('visual')}>
              <Eye size={15} /> <span>Visual</span>
            </button>
            <button className={mode === 'source' ? 'active' : ''} aria-pressed={mode === 'source'} onClick={() => setMode('source')}>
              <Code2 size={15} /> <span>Markdown</span>
            </button>
          </div>
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

      <div className="page-body">
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
        <TagEditor pageId={page.id} tags={summary?.tags ?? page.tags} />
        {mode === 'visual' ? (
          <VisualEditor key={`v${revision}`} ref={editor} initialContent={content} onChange={setContent} {...env} />
        ) : (
          <Suspense fallback={null}>
            <SourceEditor key={`s${revision}`} ref={editor} value={content} onChange={setContent} {...env} />
          </Suspense>
        )}
        <Backlinks pageId={page.id} />
      </div>

      {moving && summary && <MoveDialog page={summary} onClose={() => setMoving(false)} />}
      {historyOpen && (
        <HistoryDialog
          pageId={page.id}
          currentContent={content}
          beforeRestore={flush}
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
  };
  const { icon, label } = map[status];
  return (
    <span className={`save-status status-${status}`} role="status" aria-live="polite">
      {icon}
      <span>{label}</span>
    </span>
  );
}
