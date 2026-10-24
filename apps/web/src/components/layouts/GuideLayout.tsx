import { useState } from 'react';
import { ListOrdered, Play } from 'lucide-react';
import { blocksByKey } from '@nicotes/shared';
import { useLocalState } from '../../lib/storage';
import { InlineMarkdown } from '../Markdown';
import { StepRunner } from './StepRunner';
import { TimerChips, TimerTray, useTimers } from './Timers';
import { stepsFrom, type LayoutProps } from './types';

/** Instructions to follow in order: an overview of all steps, and one at a time full screen. */
export function GuideLayout({ pageId, notebookId, title, blocks, spec }: LayoutProps) {
  const steps = stepsFrom(blocksByKey(blocks, spec.steps));
  const [running, setRunning] = useState(false);
  const [current, setCurrent] = useLocalState(`nicotes.step.${pageId}`, 0);
  const timers = useTimers();

  if (!steps.length) {
    return (
      <div className="layout-empty">
        <ListOrdered size={26} className="muted" />
        <p className="muted">No steps found. Let the AI pick them, or choose another layout.</p>
      </div>
    );
  }

  return (
    <div className="guide">
      <div className="recipe-bar">
        <span className="muted">
          {steps.length} steps{current > 0 && current < steps.length ? ` · you were at step ${current + 1}` : ''}
        </span>
        <button className="btn btn-primary" onClick={() => setRunning(true)}>
          <Play size={16} /> {current > 0 && current < steps.length ? 'Continue' : 'Start'}
        </button>
      </div>
      <ol className="guide-steps">
        {steps.map((s, i) => (
          <li key={s.key} className={i === current ? 'current' : undefined}>
            <span className="guide-number">{i + 1}</span>
            <div>
              <InlineMarkdown text={s.text} notebookId={notebookId} />
              {s.details.length > 0 && (
                <ul>
                  {s.details.map((d, n) => (
                    <li key={n}>
                      <InlineMarkdown text={d} notebookId={notebookId} />
                    </li>
                  ))}
                </ul>
              )}
              <TimerChips text={[s.text, ...s.details].join(' ')} timers={timers} />
            </div>
          </li>
        ))}
      </ol>
      {running && (
        <StepRunner
          title={title || 'Step by step'}
          steps={steps}
          notebookId={notebookId}
          timers={timers}
          index={current}
          onIndex={setCurrent}
          onClose={() => setRunning(false)}
        />
      )}
      {!running && <TimerTray timers={timers} />}
    </div>
  );
}
