import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { diffLines } from 'diff';
import { History, RotateCcw, X } from 'lucide-react';
import type { VersionReason } from '@nicotes/shared';
import { timeAgo } from '../lib/format';
import { useRestoreVersion, useVersion, useVersions } from '../lib/queries';

const REASONS: Record<VersionReason, string> = {
  edit: 'Edited',
  relink: 'Before links were updated',
  restore: 'Before a restore',
};

const CONTEXT = 3;

interface Line {
  kind: 'same' | 'added' | 'removed' | 'gap';
  text: string;
}

/** Line diff from `before` to `after`, with long unchanged stretches collapsed. */
function diffView(before: string, after: string): Line[] {
  const lines: Line[] = [];
  for (const part of diffLines(before, after)) {
    const kind = part.added ? 'added' : part.removed ? 'removed' : 'same';
    for (const text of part.value.replace(/\n$/, '').split('\n')) lines.push({ kind, text });
  }
  const near = (i: number) =>
    lines.slice(Math.max(0, i - CONTEXT), i + CONTEXT + 1).some((l) => l.kind !== 'same');
  const out: Line[] = [];
  let skipped = 0;
  lines.forEach((line, i) => {
    if (line.kind !== 'same' || near(i)) {
      if (skipped) out.push({ kind: 'gap', text: `${skipped} unchanged ${skipped === 1 ? 'line' : 'lines'}` });
      skipped = 0;
      out.push(line);
    } else {
      skipped++;
    }
  });
  if (skipped) out.push({ kind: 'gap', text: `${skipped} unchanged ${skipped === 1 ? 'line' : 'lines'}` });
  return out;
}

interface Props {
  pageId: string;
  currentContent: string;
  /** Saves pending edits so the restore is based on what the user sees. */
  beforeRestore: () => Promise<void>;
  onClose: () => void;
}

export function HistoryDialog({ pageId, currentContent, beforeRestore, onClose }: Props) {
  const versions = useVersions(pageId);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<'diff' | 'text'>('diff');
  const version = useVersion(pageId, selected);
  const restore = useRestoreVersion();

  useEffect(() => {
    if (!selected && versions.data?.length) setSelected(versions.data[0]!.id);
  }, [versions.data, selected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Shows what restoring would change: from the current text to the selected version.
  const lines = useMemo(
    () => (version.data ? diffView(currentContent, version.data.content) : []),
    [version.data, currentContent],
  );
  const unchanged = version.data?.content === currentContent;

  const doRestore = async () => {
    if (!selected) return;
    await beforeRestore();
    restore.mutate({ pageId, versionId: selected }, { onSuccess: onClose });
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
                <span className="muted history-date">
                  {version.data && new Date(version.data.createdAt).toLocaleString()}
                </span>
                <button
                  className="btn btn-primary btn-sm"
                  disabled={!version.data || unchanged || restore.isPending}
                  onClick={() => void doRestore()}
                >
                  <RotateCcw size={14} /> Restore
                </button>
              </div>
              {version.data && mode === 'diff' && (
                <pre className="diff" aria-label="Changes from the current text to this version">
                  {unchanged && <span className="diff-gap">Identical to the current text</span>}
                  {lines.map((line, i) => (
                    <span key={i} className={`diff-${line.kind}`}>
                      {line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '− ' : line.kind === 'gap' ? '' : '  '}
                      {line.text || ' '}
                    </span>
                  ))}
                </pre>
              )}
              {version.data && mode === 'text' && <pre className="diff">{version.data.content}</pre>}
              {restore.error && <p className="error">{restore.error.message}</p>}
              <p className="muted history-hint">
                Green lines come back, red lines go away. Restoring keeps the current text as a new version and leaves the
                title unchanged.
              </p>
            </section>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
