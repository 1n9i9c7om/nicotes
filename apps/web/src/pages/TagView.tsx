import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { FileText, GitFork, Hash, Pencil, Trash2 } from 'lucide-react';
import { normalizeTag, TEMPLATE_TAG } from '@nicotes/shared';
import { Menu } from '../components/Menu';
import { ConfirmDialog, Modal } from '../components/Modal';
import { timeAgo } from '../lib/format';
import { useDeleteTag, useNotebooks, usePages, useTags, useUpdateTag } from '../lib/queries';
import { inheritedTagMap } from '../lib/tags';
import { ancestors, buildTree, displayTitle } from '../lib/tree';
import { NotFound } from './NotFound';

const SUBPAGE_PREVIEW = 6;

/** A tag's hub: its description plus every tagged page with its sub-articles. */
export function TagView() {
  const { tagName = '' } = useParams();
  const navigate = useNavigate();
  const tags = useTags();
  const pages = usePages();
  const notebooks = useNotebooks();
  const updateTag = useUpdateTag();
  const deleteTag = useDeleteTag();
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const tree = useMemo(() => buildTree(pages.data ?? []), [pages.data]);
  const tag = tags.data?.find((t) => t.name === tagName);
  // Templates hand their tags on to new pages; they are not content of the hub.
  const tagged = (pages.data ?? [])
    .filter((p) => p.tags.includes(tagName) && (tagName === TEMPLATE_TAG || !p.tags.includes(TEMPLATE_TAG)))
    .sort((a, b) => a.title.localeCompare(b.title));
  const notebookById = new Map(notebooks.data?.map((n) => [n.id, n]));
  const inheritedCount = useMemo(() => {
    let n = 0;
    for (const list of inheritedTagMap(pages.data ?? [], tags.data ?? []).values()) if (list.some((t) => t.name === tagName)) n++;
    return n;
  }, [pages.data, tags.data, tagName]);

  if (tags.isPending || pages.isPending) return null;
  if (!tag) return <NotFound what="Tag" />;

  return (
    <div className="content">
      <header className="content-header notebook-header">
        <span className="tag-badge">
          <Hash size={22} />
        </span>
        <div className="notebook-heading">
          <h1>{tag.name}</h1>
          <p className="muted">
            {tagged.length} {tagged.length === 1 ? 'page' : 'pages'}
          </p>
        </div>
        <div className="header-actions">
          <Menu
            label="Tag actions"
            items={[
              { label: 'Rename tag', icon: <Pencil size={15} />, onSelect: () => setRenaming(true) },
              { label: 'Delete tag', icon: <Trash2 size={15} />, danger: true, onSelect: () => setDeleting(true) },
            ]}
          />
        </div>
      </header>

      <label className="check-row tag-inherit" title="Search, the graph and the tag filter then include all subpages of tagged pages">
        <input
          type="checkbox"
          checked={tag.inherit}
          onChange={(e) => updateTag.mutate({ tag: tag.name, update: { inherit: e.target.checked } })}
        />
        <GitFork size={14} /> Also applies to subpages of tagged pages
        {tag.inherit && inheritedCount > 0 && <span className="muted">· {inheritedCount} more pages</span>}
      </label>

      <Description
        key={tag.name}
        value={tag.description}
        onSave={(description) => updateTag.mutate({ tag: tag.name, update: { description } })}
      />

      {tagged.length === 0 ? (
        <div className="empty-state">
          <p className="muted">No pages carry this tag yet. Add it from a page's tag bar.</p>
        </div>
      ) : (
        <div className="card-grid hub-grid">
          {tagged.map((page) => {
            const nb = notebookById.get(page.notebookId);
            const kids = tree.children.get(page.id) ?? [];
            const where = [nb?.title, ...ancestors(tree, page.id).map((a) => displayTitle(a.title))].join(' › ');
            return (
              <article key={page.id} className="card hub-card" style={{ '--card-accent': nb?.color } as never}>
                <Link to={`/p/${page.id}`} className="card-title hub-title">
                  {displayTitle(page.title)}
                </Link>
                <span className="card-meta hub-where">{where}</span>
                {kids.length > 0 && (
                  <ul className="hub-subpages">
                    {kids.slice(0, SUBPAGE_PREVIEW).map((kid) => (
                      <li key={kid.id}>
                        <Link to={`/p/${kid.id}`}>
                          <FileText size={13} />
                          {displayTitle(kid.title)}
                        </Link>
                      </li>
                    ))}
                    {kids.length > SUBPAGE_PREVIEW && (
                      <li className="muted">+{kids.length - SUBPAGE_PREVIEW} more</li>
                    )}
                  </ul>
                )}
                <span className="card-meta">{timeAgo(page.updatedAt)}</span>
              </article>
            );
          })}
        </div>
      )}

      {renaming && (
        <RenameTagDialog
          name={tag.name}
          error={updateTag.error?.message}
          onClose={() => setRenaming(false)}
          onRename={(name) =>
            updateTag.mutate(
              { tag: tag.name, update: { name } },
              {
                onSuccess: () => {
                  setRenaming(false);
                  navigate(`/t/${encodeURIComponent(name)}`, { replace: true });
                },
              },
            )
          }
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete tag?"
          message={`#${tag.name} will be removed from ${tagged.length} ${tagged.length === 1 ? 'page' : 'pages'}. The pages stay.`}
          confirmLabel="Delete"
          danger
          onClose={() => setDeleting(false)}
          onConfirm={() => deleteTag.mutate(tag.name, { onSuccess: () => navigate('/') })}
        />
      )}
    </div>
  );
}

/** Plain-text description, saved when the field loses focus. */
function Description({ value, onSave }: { value: string; onSave: (value: string) => void }) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  return (
    <textarea
      ref={ref}
      className="tag-description"
      rows={1}
      placeholder="Describe this tag — it turns this view into a hub page."
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text !== value && onSave(text)}
    />
  );
}

function RenameTagDialog({
  name,
  error,
  onClose,
  onRename,
}: {
  name: string;
  error?: string;
  onClose: () => void;
  onRename: (name: string) => void;
}) {
  const [value, setValue] = useState(name);
  const next = normalizeTag(value);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (next && next !== name) onRename(next);
  };
  return (
    <Modal title="Rename tag" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label className="field">
          <span>Name</span>
          <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        {next && next !== value.trim() && <p className="muted">Will be saved as #{next}</p>}
        {error && <p className="error">{error}</p>}
        <div className="modal-footer">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!next || next === name}>
            Rename
          </button>
        </div>
      </form>
    </Modal>
  );
}
