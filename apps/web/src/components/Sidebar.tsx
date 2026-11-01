import { createContext, useContext, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router';
import {
  CalendarCheck,
  CalendarDays,
  ChevronRight,
  LayoutTemplate,
  ListChecks,
  Download,
  FileDown,
  FilePlus,
  FileText,
  FolderInput,
  Globe,
  Hash,
  House,
  LogOut,
  MessageCircleQuestion,
  Palette,
  Pencil,
  Plus,
  Search,
  Settings,
  Telescope,
  Trash2,
  Waypoints,
  Wand2,
  X,
} from 'lucide-react';
import type { Notebook, PageSummary, User } from '@nicotes/shared';
import logo from '../logo.svg';
import {
  useCreatePage,
  useDeleteNotebook,
  useDeletePage,
  useMoveNotebook,
  useMovePage,
  useNotebooks,
  usePages,
  useRenamePage,
  useSignOut,
  useTags,
  useTasks,
  exportUrl,
} from '../lib/queries';
import { useLocalState } from '../lib/storage';
import { localDate, useOpenDailyNote } from '../lib/daily';
import { buildTree, childrenOf, displayTitle, isDescendant, rootKey, type PageTree } from '../lib/tree';
import { TemplateDialog } from './TemplateDialog';
import { Menu } from './Menu';
import { ConfirmDialog } from './Modal';
import { MoveDialog } from './MoveDialog';
import { NotebookDialog } from './NotebookDialog';
import { ShareDialog } from './ShareDialog';

type DropPosition = 'before' | 'after' | 'inside';
type Drag = { kind: 'page' | 'notebook'; id: string };
type DropTarget = { id: string; position: DropPosition };

interface TreeState {
  tree: PageTree;
  expanded: Record<string, boolean>;
  setExpanded: (id: string, open: boolean) => void;
  drag: Drag | null;
  setDrag: (drag: Drag | null) => void;
  dropTarget: DropTarget | null;
  setDropTarget: (target: DropTarget | null) => void;
  renamingId: string | null;
  setRenamingId: (id: string | null) => void;
  addPage: (notebookId: string, parentId: string | null) => void;
  movePage: (target: PageSummary | Notebook, position: DropPosition) => void;
  moveNotebook: (target: Notebook, position: DropPosition) => void;
  confirm: (dialog: ConfirmState) => void;
  startMove: (page: PageSummary) => void;
  startFromTemplate: (notebookId: string, parentId: string | null) => void;
}

interface ConfirmState {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
}

const TreeContext = createContext<TreeState | null>(null);
const useTreeState = () => useContext(TreeContext)!;

/** Where in a row the pointer is: top quarter = before, bottom quarter = after, else inside. */
function dropPosition(e: DragEvent, allowInside: boolean): DropPosition {
  const rect = e.currentTarget.getBoundingClientRect();
  const y = (e.clientY - rect.top) / rect.height;
  if (!allowInside) return y < 0.5 ? 'before' : 'after';
  return y < 0.25 ? 'before' : y > 0.75 ? 'after' : 'inside';
}

interface SidebarProps {
  user: User;
  onClose: () => void;
  onSearch: () => void;
}

export function Sidebar({ user, onClose, onSearch }: SidebarProps) {
  const navigate = useNavigate();
  const notebooks = useNotebooks();
  const pages = usePages();
  const createPage = useCreatePage();
  const movePageMutation = useMovePage();
  const moveNotebookMutation = useMoveNotebook();
  const signOut = useSignOut();

  const [expanded, setExpandedMap] = useLocalState<Record<string, boolean>>('nicotes.expanded', {});
  const [drag, setDrag] = useState<Drag | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [creatingNotebook, setCreatingNotebook] = useState(false);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [moving, setMoving] = useState<PageSummary | null>(null);
  const [fromTemplate, setFromTemplate] = useState<{ notebookId: string; parentId: string | null } | null>(null);
  const openDaily = useOpenDailyNote();
  const tags = useTags();
  const [tagsOpen, setTagsOpen] = useLocalState('nicotes.tagsOpen', true);

  const tree = useMemo(() => buildTree(pages.data ?? []), [pages.data]);

  const state: TreeState = {
    tree,
    expanded,
    setExpanded: (id, open) => setExpandedMap((prev) => ({ ...prev, [id]: open })),
    drag,
    setDrag,
    dropTarget,
    setDropTarget,
    renamingId,
    setRenamingId,
    confirm: setConfirmState,
    startMove: setMoving,
    startFromTemplate: (notebookId, parentId) => setFromTemplate({ notebookId, parentId }),
    addPage: async (notebookId, parentId) => {
      const page = await createPage.mutateAsync({ notebookId, parentId });
      setExpandedMap((prev) => ({ ...prev, [parentId ?? notebookId]: true }));
      navigate(`/p/${page.id}`, { state: { created: page } });
    },
    movePage: (target, position) => {
      if (drag?.kind !== 'page') return;
      const id = drag.id;
      // Dropping onto a notebook row appends to that notebook's root.
      if (!('notebookId' in target)) {
        const roots = (tree.children.get(rootKey(target.id)) ?? []).filter((p) => p.id !== id);
        movePageMutation.mutate({ id, notebookId: target.id, parentId: null, index: roots.length });
        setExpandedMap((prev) => ({ ...prev, [target.id]: true }));
        return;
      }
      if (target.id === id || isDescendant(tree, target.id, id)) return;
      if (position === 'inside') {
        const kids = childrenOf(tree, target).filter((p) => p.id !== id);
        movePageMutation.mutate({ id, notebookId: target.notebookId, parentId: target.id, index: kids.length });
        setExpandedMap((prev) => ({ ...prev, [target.id]: true }));
        return;
      }
      const siblings = (tree.children.get(target.parentId ?? rootKey(target.notebookId)) ?? []).filter(
        (p) => p.id !== id,
      );
      const index = siblings.findIndex((p) => p.id === target.id) + (position === 'after' ? 1 : 0);
      movePageMutation.mutate({ id, notebookId: target.notebookId, parentId: target.parentId, index });
    },
    moveNotebook: (target, position) => {
      if (drag?.kind !== 'notebook' || drag.id === target.id) return;
      const rest = (notebooks.data ?? []).filter((n) => n.id !== drag.id);
      const index = rest.findIndex((n) => n.id === target.id) + (position === 'after' ? 1 : 0);
      moveNotebookMutation.mutate({ id: drag.id, index });
    },
  };

  return (
    <TreeContext.Provider value={state}>
      <aside className="sidebar" aria-label="Navigation">
        <div className="sidebar-header">
          <img src={logo} alt="" className="sidebar-logo" />
          <span className="sidebar-brand">Nicotes</span>
          <button className="icon-btn sidebar-close" aria-label="Close sidebar" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <nav className="sidebar-scroll" onDragEnd={() => (setDrag(null), setDropTarget(null))}>
          <button className="nav-item search-item" onClick={onSearch}>
            <Search size={16} /> Search
            <kbd>Ctrl K</kbd>
          </button>
          <NavLink to="/" end className="nav-item">
            <House size={16} /> Home
          </NavLink>
          <button className="nav-item nav-button" onClick={() => void openDaily()}>
            <CalendarCheck size={16} /> Today
          </button>
          <NavLink to="/journal" className="nav-item">
            <CalendarDays size={16} /> Journal
          </NavLink>
          <NavLink to="/tasks" className="nav-item">
            <ListChecks size={16} /> Tasks
            <DueCount />
          </NavLink>
          <NavLink to="/ask" className="nav-item">
            <MessageCircleQuestion size={16} /> Ask
          </NavLink>
          <NavLink to="/graph" className="nav-item">
            <Waypoints size={16} /> Graph
          </NavLink>
          <NavLink to="/research" className="nav-item">
            <Telescope size={16} /> Research
          </NavLink>
          <NavLink to="/import" className="nav-item">
            <Download size={16} /> Import
          </NavLink>

          <div className="sidebar-section">
            <span>Notebooks</span>
            <button className="icon-btn" aria-label="New notebook" onClick={() => setCreatingNotebook(true)}>
              <Plus size={16} />
            </button>
          </div>

          {notebooks.data?.map((nb) => <NotebookNode key={nb.id} notebook={nb} />)}
          {notebooks.data?.length === 0 && (
            <button className="sidebar-empty" onClick={() => setCreatingNotebook(true)}>
              <Plus size={14} /> Create your first notebook
            </button>
          )}

          {!!tags.data?.length && (
            <>
              <div className="sidebar-section">
                <button className="section-toggle" aria-expanded={tagsOpen} onClick={() => setTagsOpen(!tagsOpen)}>
                  Tags
                  <ChevronRight size={12} className={tagsOpen ? 'tree-toggle open' : 'tree-toggle'} />
                </button>
              </div>
              {tagsOpen &&
                tags.data.map((tag) => (
                  <NavLink key={tag.name} to={`/t/${encodeURIComponent(tag.name)}`} className="nav-item tag-item">
                    <Hash size={14} />
                    <span className="tree-title">{tag.name}</span>
                    <span className="tag-count">{tag.count}</span>
                  </NavLink>
                ))}
            </>
          )}
        </nav>

        <div className="sidebar-footer">
          <span className="avatar" aria-hidden>
            {user.username.slice(0, 1).toUpperCase()}
          </span>
          <span className="sidebar-user">{user.username}</span>
          <NavLink to="/trash" className="icon-btn" aria-label="Trash" title="Trash">
            <Trash2 size={16} />
          </NavLink>
          <NavLink to="/settings" className="icon-btn" aria-label="Settings" title="Settings">
            <Settings size={16} />
          </NavLink>
          <button className="icon-btn" aria-label="Sign out" title="Sign out" onClick={() => signOut.mutate()}>
            <LogOut size={16} />
          </button>
        </div>
      </aside>

      {creatingNotebook && (
        <NotebookDialog
          onClose={() => setCreatingNotebook(false)}
          onCreated={(nb) => navigate(`/n/${nb.id}`)}
        />
      )}
      {moving && <MoveDialog page={moving} onClose={() => setMoving(null)} />}
      {fromTemplate && <TemplateDialog {...fromTemplate} onClose={() => setFromTemplate(null)} />}
      {confirmState && (
        <ConfirmDialog {...confirmState} danger onClose={() => setConfirmState(null)} />
      )}
    </TreeContext.Provider>
  );
}

function NotebookNode({ notebook }: { notebook: Notebook }) {
  const s = useTreeState();
  const navigate = useNavigate();
  const deleteNotebook = useDeleteNotebook();
  const [editing, setEditing] = useState(false);
  const [sharing, setSharing] = useState(false);
  const roots = s.tree.children.get(rootKey(notebook.id)) ?? [];
  const open = s.expanded[notebook.id] ?? true;
  const drop = s.dropTarget?.id === notebook.id ? s.dropTarget.position : null;

  const onDragOver = (e: DragEvent) => {
    if (!s.drag) return;
    e.preventDefault();
    const position = s.drag.kind === 'page' ? 'inside' : dropPosition(e, false);
    if (s.dropTarget?.id !== notebook.id || s.dropTarget.position !== position) {
      s.setDropTarget({ id: notebook.id, position });
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    if (s.drag?.kind === 'page') s.movePage(notebook, 'inside');
    else if (s.dropTarget) s.moveNotebook(notebook, s.dropTarget.position);
    s.setDrag(null);
    s.setDropTarget(null);
  };

  return (
    <div className="tree-group">
      <div
        className={`tree-row notebook-row${drop ? ` drop-${drop}` : ''}`}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', notebook.title);
          s.setDrag({ kind: 'notebook', id: notebook.id });
        }}
        onDragOver={onDragOver}
        onDragLeave={() => s.dropTarget?.id === notebook.id && s.setDropTarget(null)}
        onDrop={onDrop}
      >
        <button
          className={`tree-toggle${open ? ' open' : ''}`}
          aria-label={open ? 'Collapse' : 'Expand'}
          onClick={() => s.setExpanded(notebook.id, !open)}
        >
          <ChevronRight size={14} />
        </button>
        <NavLink to={`/n/${notebook.id}`} className="tree-link">
          <span className="notebook-dot" style={{ background: notebook.color ?? 'var(--accent)' }} />
          <span className="tree-title">{notebook.title}</span>
        </NavLink>
        <div className="tree-actions">
          <button className="icon-btn" aria-label="New page" title="New page" onClick={() => s.addPage(notebook.id, null)}>
            <Plus size={15} />
          </button>
          <Menu
            items={[
              { label: 'New page', icon: <FilePlus size={15} />, onSelect: () => s.addPage(notebook.id, null) },
              { label: 'New page from template…', icon: <LayoutTemplate size={15} />, onSelect: () => s.startFromTemplate(notebook.id, null) },
              { label: 'Edit notebook', icon: <Palette size={15} />, onSelect: () => setEditing(true) },
              {
                label: 'Organize with AI',
                icon: <Wand2 size={15} />,
                onSelect: () => navigate(`/organize?scope=notebook&id=${notebook.id}`),
              },
              {
                label: 'Export as Markdown',
                icon: <FileDown size={15} />,
                onSelect: () => (window.location.href = exportUrl(notebook.id)),
              },
              { label: 'Share…', icon: <Globe size={15} />, onSelect: () => setSharing(true) },
              {
                label: 'Delete notebook',
                icon: <Trash2 size={15} />,
                danger: true,
                onSelect: () =>
                  s.confirm({
                    title: 'Delete notebook?',
                    message: `"${notebook.title}" and all of its pages will be moved to the trash.`,
                    confirmLabel: 'Delete',
                    onConfirm: () => deleteNotebook.mutate(notebook.id, { onSuccess: () => navigate('/') }),
                  }),
              },
            ]}
          />
        </div>
      </div>

      {open && (
        <div className="tree-children" role="group">
          {roots.map((page) => (
            <PageNode key={page.id} page={page} depth={1} />
          ))}
          {roots.length === 0 && <div className="tree-hint">No pages yet</div>}
        </div>
      )}

      {editing && <NotebookDialog notebook={notebook} onClose={() => setEditing(false)} />}
      {sharing && <ShareDialog kind="notebook" targetId={notebook.id} title={notebook.title} onClose={() => setSharing(false)} />}
    </div>
  );
}

function PageNode({ page, depth }: { page: PageSummary; depth: number }) {
  const s = useTreeState();
  const navigate = useNavigate();
  const deletePage = useDeletePage();
  const kids = childrenOf(s.tree, page);
  const open = s.expanded[page.id] ?? false;
  const drop = s.dropTarget?.id === page.id ? s.dropTarget.position : null;
  const renaming = s.renamingId === page.id;

  const onDragOver = (e: DragEvent) => {
    if (s.drag?.kind !== 'page' || s.drag.id === page.id || isDescendant(s.tree, page.id, s.drag.id)) return;
    e.preventDefault();
    e.stopPropagation();
    const position = dropPosition(e, true);
    if (s.dropTarget?.id !== page.id || s.dropTarget.position !== position) {
      s.setDropTarget({ id: page.id, position });
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (s.dropTarget?.id === page.id) s.movePage(page, s.dropTarget.position);
    s.setDrag(null);
    s.setDropTarget(null);
  };

  return (
    <>
      <div
        className={`tree-row${drop ? ` drop-${drop}` : ''}`}
        style={{ paddingLeft: `calc(${depth} * var(--tree-indent))` }}
        draggable={!renaming}
        onDragStart={(e) => {
          e.stopPropagation();
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', displayTitle(page.title));
          s.setDrag({ kind: 'page', id: page.id });
        }}
        onDragOver={onDragOver}
        onDragLeave={() => s.dropTarget?.id === page.id && s.setDropTarget(null)}
        onDrop={onDrop}
      >
        {kids.length > 0 ? (
          <button
            className={`tree-toggle${open ? ' open' : ''}`}
            aria-label={open ? 'Collapse' : 'Expand'}
            onClick={() => s.setExpanded(page.id, !open)}
          >
            <ChevronRight size={14} />
          </button>
        ) : (
          <span className="tree-toggle placeholder" />
        )}
        {renaming ? (
          <RenameInput page={page} onDone={() => s.setRenamingId(null)} />
        ) : (
          <NavLink to={`/p/${page.id}`} className="tree-link" onDoubleClick={() => s.setRenamingId(page.id)}>
            <FileText size={14} className="tree-icon" />
            <span className={page.title.trim() ? 'tree-title' : 'tree-title untitled'}>
              {displayTitle(page.title)}
            </span>
          </NavLink>
        )}
        <div className="tree-actions">
          <button
            className="icon-btn"
            aria-label="New subpage"
            title="New subpage"
            onClick={() => s.addPage(page.notebookId, page.id)}
          >
            <Plus size={15} />
          </button>
          <Menu
            items={[
              { label: 'New subpage', icon: <FilePlus size={15} />, onSelect: () => s.addPage(page.notebookId, page.id) },
              {
                label: 'Subpage from template…',
                icon: <LayoutTemplate size={15} />,
                onSelect: () => s.startFromTemplate(page.notebookId, page.id),
              },
              { label: 'Rename', icon: <Pencil size={15} />, onSelect: () => s.setRenamingId(page.id) },
              { label: 'Move to…', icon: <FolderInput size={15} />, onSelect: () => s.startMove(page) },
              {
                label: 'Organize with AI',
                icon: <Wand2 size={15} />,
                onSelect: () => navigate(`/organize?scope=${kids.length ? 'subtree' : 'page'}&id=${page.id}`),
              },
              {
                label: 'Delete',
                icon: <Trash2 size={15} />,
                danger: true,
                onSelect: () =>
                  s.confirm({
                    title: 'Delete page?',
                    message:
                      kids.length > 0
                        ? `"${displayTitle(page.title)}" and its subpages will be moved to the trash.`
                        : `"${displayTitle(page.title)}" will be moved to the trash.`,
                    confirmLabel: 'Delete',
                    onConfirm: () =>
                      deletePage.mutate(page.id, {
                        onSuccess: () => {
                          // Leave the editor if it shows the deleted page or one of its subpages.
                          const openId = /^\/p\/([^/]+)/.exec(window.location.pathname)?.[1];
                          if (openId && (openId === page.id || isDescendant(s.tree, openId, page.id))) {
                            navigate(`/n/${page.notebookId}`);
                          }
                        },
                      }),
                  }),
              },
            ]}
          />
        </div>
      </div>
      {open && kids.map((child) => <PageNode key={child.id} page={child} depth={depth + 1} />)}
    </>
  );
}

function RenameInput({ page, onDone }: { page: PageSummary; onDone: () => void }) {
  const rename = useRenamePage();
  const [value, setValue] = useState(page.title);
  const done = useRef(false);

  const finish = (save: boolean) => {
    if (done.current) return; // Enter/Escape unmount the input, which also fires blur.
    done.current = true;
    if (save && value.trim() !== page.title) rename.mutate({ id: page.id, title: value.trim() });
    onDone();
  };
  const commit = () => finish(true);

  return (
    <input
      className="tree-rename"
      autoFocus
      value={value}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') finish(false);
      }}
    />
  );
}

/** Open tasks due today or earlier, as a small badge on the Tasks entry. */
function DueCount() {
  const tasks = useTasks();
  const today = localDate();
  const due = (tasks.data ?? []).filter((t) => !t.done && t.due && t.due <= today);
  if (!due.length) return null;
  const overdue = due.some((t) => t.due! < today);
  return (
    <span className={overdue ? 'nav-count overdue' : 'nav-count'} title={`${due.length} due today or overdue`}>
      {due.length}
    </span>
  );
}
