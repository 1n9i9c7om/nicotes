import { useState } from 'react';
import { BookOpen, FileText, RotateCcw, Trash2 } from 'lucide-react';
import { TRASH_RETENTION_DAYS, type TrashItem } from '@nicotes/shared';
import { ConfirmDialog } from '../components/Modal';
import { timeAgo } from '../lib/format';
import { useDeleteForever, useRestoreTrash, useTrash } from '../lib/queries';
import { displayTitle } from '../lib/tree';

const DAY = 24 * 60 * 60 * 1000;

function describe(item: TrashItem): string {
  const others = item.kind === 'notebook' ? item.pageCount : item.pageCount - 1;
  const what = item.kind === 'notebook' ? 'page' : 'subpage';
  const parts = [item.kind === 'notebook' ? 'Notebook' : item.notebookTitle];
  if (others > 0) parts.push(`${others} ${what}${others === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

export function TrashPage() {
  const trash = useTrash();
  const restore = useRestoreTrash();
  const remove = useDeleteForever();
  const [confirm, setConfirm] = useState<TrashItem | 'all' | null>(null);
  const items = trash.data ?? [];

  return (
    <div className="content trash">
      <header className="content-header notebook-header">
        <div className="notebook-heading">
          <h1>Trash</h1>
          <p className="muted">Deleted pages and notebooks are removed for good after {TRASH_RETENTION_DAYS} days.</p>
        </div>
        {items.length > 0 && (
          <div className="header-actions">
            <button className="btn btn-danger" onClick={() => setConfirm('all')}>
              <Trash2 size={16} /> Empty trash
            </button>
          </div>
        )}
      </header>

      {trash.isSuccess && items.length === 0 ? (
        <div className="empty-state">
          <Trash2 size={28} className="muted" />
          <p className="muted">The trash is empty.</p>
        </div>
      ) : (
        <ul className="trash-list">
          {items.map((item) => {
            const daysLeft = Math.max(0, Math.ceil((item.deletedAt + TRASH_RETENTION_DAYS * DAY - Date.now()) / DAY));
            return (
              <li key={`${item.kind}:${item.id}`} className="trash-item">
                {item.kind === 'notebook' ? <BookOpen size={18} /> : <FileText size={18} />}
                <div className="trash-info">
                  <span className="trash-title">{displayTitle(item.title)}</span>
                  <span className="trash-meta">
                    {describe(item)} · deleted {timeAgo(item.deletedAt)} · {daysLeft} {daysLeft === 1 ? 'day' : 'days'} left
                  </span>
                </div>
                <div className="trash-actions">
                  <button
                    className="btn btn-sm"
                    disabled={restore.isPending}
                    onClick={() => restore.mutate({ kind: item.kind, id: item.id })}
                  >
                    <RotateCcw size={14} /> Restore
                  </button>
                  <button className="icon-btn" aria-label="Delete forever" title="Delete forever" onClick={() => setConfirm(item)}>
                    <Trash2 size={16} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {restore.error && <p className="error">{restore.error.message}</p>}

      {confirm && (
        <ConfirmDialog
          title={confirm === 'all' ? 'Empty trash?' : 'Delete forever?'}
          message={
            confirm === 'all'
              ? `All ${items.length} items in the trash will be deleted permanently, including their version history.`
              : `“${displayTitle(confirm.title)}”${confirm.pageCount > 1 ? ` and ${confirm.pageCount - (confirm.kind === 'page' ? 1 : 0)} more pages` : ''} will be deleted permanently, including version history. This cannot be undone.`
          }
          confirmLabel="Delete forever"
          danger
          onClose={() => setConfirm(null)}
          onConfirm={() => remove.mutate(confirm === 'all' ? 'all' : { kind: confirm.kind, id: confirm.id })}
        />
      )}
    </div>
  );
}
