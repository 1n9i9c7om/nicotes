import { Link } from 'react-router';
import { ChevronRight, CornerDownLeft } from 'lucide-react';
import { plainExcerpt } from '../lib/format';
import { useBacklinks } from '../lib/queries';
import { useLocalState } from '../lib/storage';
import { displayTitle } from '../lib/tree';

/** "Linked from" panel under the editor; collapsed state is remembered per browser. */
export function Backlinks({ pageId }: { pageId: string }) {
  const backlinks = useBacklinks(pageId);
  const [open, setOpen] = useLocalState('nicotes.backlinksOpen', true);
  const items = backlinks.data ?? [];

  if (!items.length) return null;

  return (
    <section className="backlinks" aria-label="Backlinks">
      <button className="backlinks-header" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight size={14} className={open ? 'tree-toggle open' : 'tree-toggle'} />
        <CornerDownLeft size={14} />
        Linked from {items.length} {items.length === 1 ? 'page' : 'pages'}
      </button>
      {open && (
        <ul className="backlinks-list">
          {items.map((b) => (
            <li key={b.id}>
              <Link to={`/p/${b.id}`} className="backlink">
                <span className="backlink-title">{displayTitle(b.title)}</span>
                {b.excerpt && <span className="backlink-excerpt">{plainExcerpt(b.excerpt)}</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
