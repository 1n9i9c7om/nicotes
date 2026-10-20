import { useMemo, useState } from 'react';
import { BookOpen, FileText } from 'lucide-react';
import type { PageSummary } from '@nicotes/shared';
import { fuzzyFilter } from '../lib/fuzzy';
import { useMovePage, useNotebooks, usePages } from '../lib/queries';
import { ancestors, buildTree, displayTitle, isDescendant, rootKey } from '../lib/tree';
import { Modal } from './Modal';

interface Destination {
  key: string;
  notebookId: string;
  parentId: string | null;
  label: string;
  where: string;
}

/** Touch-friendly alternative to drag & drop: pick a notebook or page to move into. */
export function MoveDialog({ page, onClose }: { page: PageSummary; onClose: () => void }) {
  const notebooks = useNotebooks();
  const pages = usePages();
  const move = useMovePage();
  const [query, setQuery] = useState('');

  const tree = useMemo(() => buildTree(pages.data ?? []), [pages.data]);
  const destinations = useMemo(() => {
    const titles = new Map(notebooks.data?.map((n) => [n.id, n.title]));
    const list: Destination[] = (notebooks.data ?? []).map((nb) => ({
      key: nb.id,
      notebookId: nb.id,
      parentId: null,
      label: nb.title,
      where: 'Notebook',
    }));
    for (const p of pages.data ?? []) {
      if (p.id === page.id || isDescendant(tree, p.id, page.id)) continue;
      list.push({
        key: p.id,
        notebookId: p.notebookId,
        parentId: p.id,
        label: displayTitle(p.title),
        where: [titles.get(p.notebookId), ...ancestors(tree, p.id).map((a) => displayTitle(a.title))].join(' › '),
      });
    }
    // Moving to where the page already is would do nothing.
    return list.filter((d) => !(d.notebookId === page.notebookId && d.parentId === page.parentId));
  }, [notebooks.data, pages.data, tree, page]);

  const shown = fuzzyFilter(destinations, query, (d) => d.label, 50);

  const choose = (d: Destination) => {
    const siblings = (tree.children.get(d.parentId ?? rootKey(d.notebookId)) ?? []).filter((p) => p.id !== page.id);
    move.mutate({ id: page.id, notebookId: d.notebookId, parentId: d.parentId, index: siblings.length });
    onClose();
  };

  return (
    <Modal title={`Move “${displayTitle(page.title)}” to…`} onClose={onClose}>
      <div className="stack">
        <input
          className="palette-input"
          autoFocus
          placeholder="Filter notebooks and pages"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && shown[0] && choose(shown[0])}
        />
        <ul className="pick-list">
          {shown.map((d) => (
            <li key={d.key}>
              <button className="pick-item" onClick={() => choose(d)}>
                {d.parentId ? <FileText size={15} /> : <BookOpen size={15} />}
                <span className="pick-label">{d.label}</span>
                <span className="pick-where">{d.where}</span>
              </button>
            </li>
          ))}
          {shown.length === 0 && <li className="muted pick-empty">No matches</li>}
        </ul>
      </div>
    </Modal>
  );
}
