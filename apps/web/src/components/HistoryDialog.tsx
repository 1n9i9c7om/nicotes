import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { History, RotateCcw, X } from 'lucide-react';
import type { VersionReason } from '@nicotes/shared';
import { timeAgo } from '../lib/format';
import { useVersion, useVersions } from '../lib/queries';
import { DiffReview, useHunkReview } from './DiffReview';

const REASONS: Record<VersionReason, string> = {
  edit: 'Edited',
  relink: 'Before links were updated',
  restore: 'Before a restore',
  assistant: 'Before AI changes',
};

interface Props {
  pageId: string;
  currentContent: string;
  /** Replaces the page content with the (partly) restored text, keeping the current one as a version. */
  onApply: (content: string) => Promise<void>;
  onClose: () => void;
}

export function HistoryDialog({ pageId, currentContent, onApply, onClose }: Props) {
  const versions = useVersions(pageId);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<'diff' | 'text'>('diff');
  // "current": what restoring would change; "previous": what changed in this version.
  const [compare, setCompare] = useState<'current' | 'previous'>('current');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = versions.data ?? [];
  const index = list.findIndex((v) => v.id === selected);
  const previousId = index >= 0 ? (list[index + 1]?.id ?? null) : null;
  const version = useVersion(pageId, selected);
  const previous = useVersion(pageId, compare === 'previous' ? previousId : null);

  useEffect(() => {
    if (!selected && versions.data?.length) setSelected(versions.data[0]!.id);
  }, [versions.data, selected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const target = version.data?.content ?? currentContent;
  const restore = useHunkReview(currentContent, target);
  const older = previousId ? previous.data?.content : '';
  const changed = useHunkReview(older ?? '', target);
  const unchanged = version.data !== undefined && restore.hunks.length === 0;
  const count = restore.accepted.size;

  const doRestore = async () => {
    setBusy(true);
    setError(null);
    try {
      await onApply(restore.result());
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal history" role="dialog" aria-modal="true" aria-label="Version history">
        <header className="history-head">
          <h2 className="modal-title">
            <History size={18} /> Version history
          </h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        {versions.data?.length === 0 ? (
          <p className="muted history-empty">
            No earlier versions yet. Nicotes keeps a snapshot at most every 10 minutes while you edit, and always before
            anything else changes the page.
          </p>
        ) : (
          <div className="history-body">
            <ul className="history-list">
              {versions.data?.map((v) => (
                <li key={v.id}>
                  <button
                    className={v.id === selected ? 'history-item active' : 'history-item'}
                    onClick={() => setSelected(v.id)}
                  >
                    <span className="history-time" title={new Date(v.createdAt).toLocaleString()}>
                      {timeAgo(v.createdAt)}
                    </span>
                    <span className="history-meta">
                      {REASONS[v.reason]} · {v.size.toLocaleString()} chars
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            <section className="history-view">
              <div className="history-toolbar">
                <div className="segmented" role="group" aria-label="View">
                  <button className={mode === 'diff' ? 'active' : ''} onClick={() => setMode('diff')}>
                    Changes
                  </button>
                  <button className={mode === 'text' ? 'active' : ''} onClick={() => setMode('text')}>
                    Full text
                  </button>
                </div>
                {mode === 'diff' && (
                  <select
                    className="history-compare"
                    aria-label="Compare with"
                    value={compare}
                    onChange={(e) => setCompare(e.target.value as 'current' | 'previous')}
                  >
                    <option value="current">Compared with the current text</option>
                    <option value="previous">Compared with the version before</option>
                  </select>
                )}
                <span className="muted history-date">
                  {version.data && new Date(version.data.createdAt).toLocaleString()}
                </span>
                {compare === 'current' && mode === 'diff' && restore.hunks.length > 1 && (
                  <span className="history-pick">
                    <button className="link-btn" onClick={restore.all}>
                      All
                    </button>
                    <button className="link-btn" onClick={restore.none}>
                      None
                    </button>
                  </span>
                )}
                <button
                  className="btn btn-primary btn-sm"
                  disabled={!version.data || unchanged || busy || count === 0}
                  onClick={() => void doRestore()}
                >
                  <RotateCcw size={14} />{' '}
                  {count < restore.hunks.length ? `Restore ${count} of ${restore.hunks.length} changes` : 'Restore'}
                </button>
              </div>
              {version.data && mode === 'diff' && compare === 'current' && (
                <DiffReview
                  label="Changes from the current text to this version"
                  before={currentContent}
                  hunks={restore.hunks}
                  accepted={restore.accepted}
                  onToggle={restore.toggle}
                />
              )}
              {version.data && mode === 'diff' && compare === 'previous' && previousId && older !== undefined && (
                <DiffReview label="Changes made in this version" before={older} hunks={changed.hunks} />
              )}
              {version.data && mode === 'diff' && compare === 'previous' && !previousId && (
                <pre className="diff">{version.data.content}</pre>
              )}
              {unchanged && compare === 'current' && mode === 'diff' && (
                <p className="muted history-hint">Identical to the current text.</p>
              )}
              {version.data && mode === 'text' && <pre className="diff">{version.data.content}</pre>}
              {error && <p className="error">{error}</p>}
              <p className="muted history-hint">
                {compare === 'current'
                  ? 'Green lines come back, red lines go away. Untick changes to restore only some of them. Restoring keeps the current text as a new version and leaves the title unchanged.'
                  : previousId
                    ? 'What changed from the version before to this one.'
                    : 'The oldest version, so there is nothing to compare it with.'}
              </p>
            </section>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
