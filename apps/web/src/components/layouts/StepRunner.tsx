import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { InlineMarkdown } from '../Markdown';
import { TimerChips, TimerTray, type Timers } from './Timers';

export interface Step {
  key: string;
  text: string;
  details: string[];
}

/**
 * One step at a time, full screen: big text, timers for durations it mentions, the ingredients
 * it uses, arrow keys and swipes to move on. Keeps the screen on while open (Wake Lock).
 */
export function StepRunner({
  title,
  steps,
  notebookId,
  timers,
  needs,
  index: wanted,
  onIndex,
  onClose,
}: {
  title: string;
  steps: Step[];
  notebookId: string;
  timers: Timers;
  /** Ingredients (already scaled) mentioned in a step. */
  needs?: (step: Step) => string[];
  /** Current step, kept by the layout (remembered per page). */
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const index = Math.min(Math.max(wanted, 0), steps.length - 1);
  const step = steps[index]!;
  const swipe = useRef<number | null>(null);
  const go = (delta: number) => onIndex(Math.min(Math.max(index + delta, 0), steps.length - 1));

  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    navigator.wakeLock
      ?.request('screen')
      .then((l) => (lock = l))
      .catch(() => {});
    return () => void lock?.release().catch(() => {});
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'PageDown') go(1);
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(-1);
      else if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const ingredients = needs?.(step) ?? [];
  const last = index === steps.length - 1;

  return createPortal(
    <div
      className="runner"
      role="dialog"
      aria-modal="true"
      aria-label={`${title}: step by step`}
      onPointerDown={(e) => (swipe.current = e.clientX)}
      onPointerUp={(e) => {
        if (swipe.current === null) return;
        const dx = e.clientX - swipe.current;
        swipe.current = null;
        if (Math.abs(dx) > 70) go(dx < 0 ? 1 : -1);
      }}
    >
      <header className="runner-head">
        <span className="runner-title">{title}</span>
        <span className="muted">
          Step {index + 1} of {steps.length}
        </span>
        <button className="icon-btn" aria-label="Close" onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      <div className="runner-progress" aria-hidden="true">
        <span style={{ width: `${((index + 1) / steps.length) * 100}%` }} />
      </div>

      <div className="runner-body">
        <div className="runner-step" key={step.key}>
          <span className="runner-number">{index + 1}</span>
          <p className="runner-text">
            <InlineMarkdown text={step.text} notebookId={notebookId} />
          </p>
          {step.details.length > 0 && (
            <ul className="runner-details">
              {step.details.map((d, i) => (
                <li key={i}>
                  <InlineMarkdown text={d} notebookId={notebookId} />
                </li>
              ))}
            </ul>
          )}
          {/* Lines under "You need" can name times too ("bake roughly 10–25 minutes"). */}
          <TimerChips text={[step.text, ...step.details, ...ingredients].join(' ')} timers={timers} />
          {ingredients.length > 0 && (
            <div className="runner-needs">
              <span className="muted">You need</span>
              <ul>
                {ingredients.map((text, i) => (
                  <li key={i}>
                    <InlineMarkdown text={text} notebookId={notebookId} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      <footer className="runner-foot">
        <button className="btn" disabled={index === 0} onClick={() => go(-1)}>
          <ChevronLeft size={18} /> Back
        </button>
        <div className="runner-dots" aria-hidden="true">
          {steps.map((s, i) => (
            <span key={s.key} className={i === index ? 'active' : i < index ? 'past' : undefined} />
          ))}
        </div>
        {last ? (
          <button className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        ) : (
          <button className="btn btn-primary" onClick={() => go(1)}>
            Next <ChevronRight size={18} />
          </button>
        )}
      </footer>
      <TimerTray timers={timers} />
    </div>,
    document.body,
  );
}
