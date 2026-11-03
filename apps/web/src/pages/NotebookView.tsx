import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Download, FilePlus, Palette, PenTool } from 'lucide-react';
import { EMPTY_CANVAS } from '@nicotes/shared';
import { NotebookDialog } from '../components/NotebookDialog';
import { timeAgo } from '../lib/format';
import { useCreatePage, useNotebooks, usePages } from '../lib/queries';
import { buildTree, displayTitle, rootKey } from '../lib/tree';
import { NotFound } from './NotFound';

export function NotebookView() {
  const { notebookId = '' } = useParams();
  const navigate = useNavigate();
  const notebooks = useNotebooks();
  const pages = usePages();
  const createPage = useCreatePage();
  const [editing, setEditing] = useState(false);

  const tree = useMemo(() => buildTree(pages.data ?? []), [pages.data]);
  const notebook = notebooks.data?.find((n) => n.id === notebookId);

  if (notebooks.isPending) return null;
  if (!notebook) return <NotFound what="Notebook" />;

  const roots = tree.children.get(rootKey(notebook.id)) ?? [];
  const addPage = async (canvas = false) => {
    const page = await createPage.mutateAsync({ notebookId: notebook.id, ...(canvas ? { content: EMPTY_CANVAS } : {}) });
    navigate(`/p/${page.id}`, { state: { created: page } });
  };

  return (
    <div className="content" style={{ '--card-accent': notebook.color } as never}>
      <header className="content-header notebook-header">
        <span className="notebook-bar" />
        <div className="notebook-heading">
          <h1>{notebook.title}</h1>
          <p className="muted">
            {roots.length} {roots.length === 1 ? 'page' : 'pages'}
          </p>
        </div>
        <div className="header-actions">
          <button className="btn" onClick={() => setEditing(true)}>
            <Palette size={16} /> Edit
          </button>
          <Link className="btn" to={`/import?notebook=${notebook.id}`}>
            <Download size={16} /> Import
          </Link>
          <button className="btn" onClick={() => void addPage(true)} disabled={createPage.isPending}>
            <PenTool size={16} /> New canvas
          </button>
          <button className="btn btn-primary" onClick={() => void addPage()} disabled={createPage.isPending}>
            <FilePlus size={16} /> New page
          </button>
        </div>
      </header>

      {roots.length === 0 ? (
        <div className="empty-state">
          <p className="muted">This notebook is empty.</p>
        </div>
      ) : (
        <div className="card-grid">
          {roots.map((page) => {
            const subpages = tree.children.get(page.id)?.length ?? 0;
            return (
              <Link key={page.id} to={`/p/${page.id}`} className="card">
                <span className="card-title">{displayTitle(page.title)}</span>
                <span className="card-meta">
                  {subpages > 0 && `${subpages} ${subpages === 1 ? 'subpage' : 'subpages'} · `}
                  {timeAgo(page.updatedAt)}
                </span>
              </Link>
            );
          })}
        </div>
      )}

      {editing && <NotebookDialog notebook={notebook} onClose={() => setEditing(false)} />}
    </div>
  );
}
