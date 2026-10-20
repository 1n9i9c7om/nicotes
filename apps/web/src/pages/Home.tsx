import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { BookPlus, FileText } from 'lucide-react';
import { NotebookDialog } from '../components/NotebookDialog';
import { timeAgo } from '../lib/format';
import { useAuthStatus, useNotebooks, usePages } from '../lib/queries';
import { buildTree, displayTitle, rootKey } from '../lib/tree';

export function Home() {
  const { data: auth } = useAuthStatus();
  const notebooks = useNotebooks();
  const pages = usePages();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);

  const tree = useMemo(() => buildTree(pages.data ?? []), [pages.data]);
  const recent = useMemo(
    () => [...(pages.data ?? [])].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8),
    [pages.data],
  );
  const notebookById = new Map(notebooks.data?.map((n) => [n.id, n]));

  return (
    <div className="content">
      <header className="content-header">
        <h1 className="greeting">Hello, {auth?.user?.username}</h1>
        <p className="muted">Pick up where you left off.</p>
      </header>

      {notebooks.data?.length === 0 ? (
        <div className="empty-state">
          <h2>Start with a notebook</h2>
          <p className="muted">
            Notebooks group related pages, such as <em>Games</em>, <em>Recipes</em> or <em>Work</em>.
          </p>
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            <BookPlus size={16} /> New notebook
          </button>
        </div>
      ) : (
        <>
          {recent.length > 0 && (
            <section className="section">
              <h2 className="section-title">Recently edited</h2>
              <ul className="recent-list">
                {recent.map((page) => {
                  const nb = notebookById.get(page.notebookId);
                  return (
                    <li key={page.id}>
                      <Link to={`/p/${page.id}`} className="recent-item">
                        <FileText size={16} className="muted" />
                        <span className="recent-title">{displayTitle(page.title)}</span>
                        <span className="recent-meta">
                          <span className="notebook-dot" style={{ background: nb?.color ?? 'var(--accent)' }} />
                          {nb?.title}
                        </span>
                        <span className="recent-time">{timeAgo(page.updatedAt)}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          <section className="section">
            <h2 className="section-title">Notebooks</h2>
            <div className="card-grid">
              {notebooks.data?.map((nb) => (
                <Link key={nb.id} to={`/n/${nb.id}`} className="card" style={{ '--card-accent': nb.color } as never}>
                  <span className="card-title">{nb.title}</span>
                  <span className="card-meta">
                    {(tree.children.get(rootKey(nb.id)) ?? []).length} pages
                  </span>
                </Link>
              ))}
              <button className="card card-new" onClick={() => setCreating(true)}>
                <BookPlus size={18} /> New notebook
              </button>
            </div>
          </section>
        </>
      )}

      {creating && (
        <NotebookDialog onClose={() => setCreating(false)} onCreated={(nb) => navigate(`/n/${nb.id}`)} />
      )}
    </div>
  );
}
