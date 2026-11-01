import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { EditorContent, useEditor } from '@tiptap/react';
import { Eye, Menu as MenuIcon, X } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router';
import { buildLinkContext, resolveWikilink, sharePath, type PublicShare, type PublicSharePage } from '@nicotes/shared';
import logo from '../logo.svg';
import { editorExtensions } from '../editor/extensions';
import { api } from '../lib/api';
import type { LinkBridge } from '../lib/links';
import { displayTitle } from '../lib/tree';

const dateOf = (time: number) => new Date(time).toLocaleDateString('en', { dateStyle: 'long' });

/**
 * /s/<token>[/<pageId>]: a shared page or notebook, read-only, for anyone with the link. No
 * account, no app around it: a page list (when there is more than one page) and the text.
 */
export function SharedView() {
  const { token = '', pageId } = useParams();
  const navigate = useNavigate();
  const [navOpen, setNavOpen] = useState(false);
  const share = useQuery({
    queryKey: ['public-share', token],
    queryFn: () => api.get<PublicShare>(`/public/shares/${encodeURIComponent(token)}`),
    staleTime: 60_000,
  });
  const data = share.data;
  const current = data?.pages.find((p) => p.id === (pageId ?? data.startId));

  // Links between shared pages stay inside the share; links to anything else are plain text.
  const bridge = useMemo<LinkBridge | null>(() => {
    if (!data) return null;
    const ctx = buildLinkContext(
      data.pages.map((p, i) => ({ id: p.id, notebookId: 'shared', parentId: p.parentId, title: p.title, createdAt: i })),
      [{ id: 'shared', title: data.kind === 'notebook' ? data.title : '' }],
    );
    const find = (target: string) => resolveWikilink(ctx, target, 'shared');
    return {
      resolve: (target) => {
        const page = find(target);
        return page ? { id: page.id, path: sharePath(token, page.id) } : null;
      },
      suggest: () => [],
      open: (target) => {
        const page = find(target);
        if (page) navigate(sharePath(token, page.id));
      },
      subscribe: () => () => {},
      readOnly: true,
    };
  }, [data, token, navigate]);

  useEffect(() => {
    document.title = current ? `${displayTitle(current.title)} · Nicotes` : 'Nicotes';
    setNavOpen(false);
  }, [current]);

  if (share.isPending) return <div className="splash" aria-busy="true" />;
  if (!data) {
    return (
      <div className="auth">
        <div className="auth-card shared-missing">
          <img src={logo} alt="" className="auth-logo" />
          <h1>This link doesn't work</h1>
          <p className="muted">{share.error?.message ?? 'It may have expired or been turned off.'}</p>
        </div>
      </div>
    );
  }

  const several = data.pages.length > 1;
  return (
    <div className="shared">
      <header className="shared-bar">
        {several && (
          <button className="icon-btn shared-nav-toggle" aria-label={navOpen ? 'Close pages' : 'Pages'} onClick={() => setNavOpen(!navOpen)}>
            {navOpen ? <X size={18} /> : <MenuIcon size={18} />}
          </button>
        )}
        <Link to={sharePath(token)} className="shared-brand">
          {data.kind === 'notebook' && <span className="notebook-dot" style={{ background: data.color ?? 'var(--accent)' }} />}
          {displayTitle(data.title)}
        </Link>
        <span className="shared-badge">
          <Eye size={14} /> Read-only
        </span>
      </header>
      <div className="shared-layout">
        {several && (
          <nav className={`shared-nav${navOpen ? ' open' : ''}`} aria-label="Pages">
            <PageTree pages={data.pages} parentId={null} token={token} currentId={current?.id} />
          </nav>
        )}
        <main className="shared-main">
          {current ? (
            <article className="page-body shared-page">
              <h1 className="shared-title">{displayTitle(current.title)}</h1>
              <ReadOnlyPage key={current.id} page={current} bridge={bridge!} />
              <p className="shared-updated">Last changed {dateOf(current.updatedAt)}</p>
            </article>
          ) : (
            <p className="muted shared-empty">
              This page is not part of what was shared. <Link to={sharePath(token)}>Back to the start</Link>
            </p>
          )}
        </main>
      </div>
      <footer className="shared-footer">
        <img src={logo} alt="" /> Shared with Nicotes
      </footer>
    </div>
  );
}

function PageTree({ pages, parentId, token, currentId }: { pages: PublicSharePage[]; parentId: string | null; token: string; currentId?: string }) {
  const level = pages.filter((p) => p.parentId === parentId);
  if (!level.length) return null;
  return (
    <ul>
      {level.map((p) => (
        <li key={p.id}>
          <Link to={sharePath(token, p.id)} className={p.id === currentId ? 'active' : undefined} aria-current={p.id === currentId ? 'page' : undefined}>
            {displayTitle(p.title)}
          </Link>
          <PageTree pages={pages} parentId={p.id} token={token} currentId={currentId} />
        </li>
      ))}
    </ul>
  );
}

/** The page as the editor shows it, but nothing can be changed. */
function ReadOnlyPage({ page, bridge }: { page: PublicSharePage; bridge: LinkBridge }) {
  const extensions = useMemo(() => editorExtensions({ bridge }), [bridge]);
  const editor = useEditor({
    extensions,
    content: page.content,
    contentType: 'markdown',
    editable: false,
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps: { attributes: { class: 'prose', 'aria-label': 'Page content' } },
  });
  return (
    <div className="editor visual-editor read-only">
      <EditorContent editor={editor} className="editor-surface" />
    </div>
  );
}
