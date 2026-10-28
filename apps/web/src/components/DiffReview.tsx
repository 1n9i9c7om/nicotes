import { useMemo, useState } from 'react';
import { applyHunks, diffHunks, diffSegments, type Hunk } from '@nicotes/shared';

/**
 * The hunks between two texts and which of them the user accepts (all at first). The
 * selection starts over whenever the texts change.
 */
export function useHunkReview(before: string, after: string) {
  const hunks = useMemo(() => diffHunks(before, after), [before, after]);
  const [state, setState] = useState(() => ({ hunks, accepted: new Set(hunks.map((h) => h.id)) }));
  const accepted = state.hunks === hunks ? state.accepted : new Set(hunks.map((h) => h.id));
  const set = (next: Set<number>) => setState({ hunks, accepted: next });
  return {
    hunks,
    accepted,
    toggle: (id: number) => {
      const next = new Set(accepted);
      if (!next.delete(id)) next.add(id);
      set(next);
    },
    all: () => set(new Set(hunks.map((h) => h.id))),
    none: () => set(new Set()),
    /** `before` with the accepted hunks applied. */
    result: () => applyHunks(before, hunks, accepted),
  };
}

export const hunkStats = (hunks: Hunk[]) => ({
  added: hunks.reduce((n, h) => n + h.added.length, 0),
  removed: hunks.reduce((n, h) => n + h.removed.length, 0),
});

interface Props {
  before: string;
  hunks: Hunk[];
  /** Accepted hunk ids; leave out for a read-only diff. */
  accepted?: Set<number>;
  onToggle?: (id: number) => void;
  label: string;
  className?: string;
  context?: number;
}

/** A line diff; with `accepted`, every change gets a checkbox, like staging hunks in git. */
export function DiffReview({ before, hunks, accepted, onToggle, label, className, context = 3 }: Props) {
  const segments = useMemo(() => diffSegments(before, hunks, context), [before, hunks, context]);
  return (
    <div className={`diff${className ? ` ${className}` : ''}`} role="group" aria-label={label}>
      {segments.map((segment, i) => {
        if (segment.type === 'gap') {
          return (
            <span key={i} className="diff-gap">
              {segment.count} unchanged {segment.count === 1 ? 'line' : 'lines'}
            </span>
          );
        }
        if (segment.type === 'same') {
          return segment.lines.map((line, j) => (
            <span key={`${i}-${j}`} className="diff-same">
              {'  '}
              {line || ' '}
            </span>
          ));
        }
        const { hunk } = segment;
        const off = accepted !== undefined && !accepted.has(hunk.id);
        return (
          <div key={i} className={`diff-hunk${off ? ' off' : ''}${accepted ? ' selectable' : ''}`}>
            {accepted && (
              <label className="diff-hunk-head">
                <input type="checkbox" checked={!off} onChange={() => onToggle?.(hunk.id)} />
                <span>
                  Change {hunk.id + 1} of {hunks.length}
                </span>
                <span className="diff-hunk-stats">
                  {hunk.added.length > 0 && <span className="plus">+{hunk.added.length}</span>}
                  {hunk.removed.length > 0 && <span className="minus">−{hunk.removed.length}</span>}
                </span>
              </label>
            )}
            {hunk.removed.map((line, j) => (
              <span key={`r${j}`} className="diff-removed">
                {'− '}
                {line || ' '}
              </span>
            ))}
            {hunk.added.map((line, j) => (
              <span key={`a${j}`} className="diff-added">
                {'+ '}
                {line || ' '}
              </span>
            ))}
          </div>
        );
      })}
    </div>
  );
}
