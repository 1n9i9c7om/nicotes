import { useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronRight, Loader2, Square, XCircle } from 'lucide-react';
import type { Job } from '@nicotes/shared';
import { useCancelJob } from '../lib/queries';

export const formatCost = (usd: number) => (usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);

/** Live status of a background AI job: current step, progress bar, cost, log and cancel. */
export function JobProgress({ job }: { job: Job }) {
  const cancel = useCancelJob();
  const [showLog, setShowLog] = useState(false);
  const active = job.status === 'queued' || job.status === 'running';
  const { message, done, total, log = [] } = job.progress;
  const percent = total ? Math.round(((done ?? 0) / total) * 100) : null;

  const icon = active ? (
    <Loader2 size={18} className="spin" />
  ) : job.status === 'done' ? (
    <CheckCircle2 size={18} />
  ) : job.status === 'cancelled' ? (
    <XCircle size={18} />
  ) : (
    <AlertTriangle size={18} />
  );

  return (
    <div className={`job job-${job.status}`} role="status" aria-live="polite">
      <div className="job-head">
        {icon}
        <span className="job-message">{job.status === 'failed' ? job.error : job.status === 'cancelled' ? 'Cancelled' : message}</span>
        <span className="job-cost" title="OpenRouter cost so far">
          {formatCost(job.cost)}
        </span>
        {active && (
          <button className="btn btn-sm" disabled={cancel.isPending} onClick={() => cancel.mutate(job.id)}>
            <Square size={12} /> Cancel
          </button>
        )}
      </div>
      {active && (
        <div className="job-bar" aria-hidden>
          <span style={percent === null ? undefined : { width: `${Math.max(4, percent)}%` }} className={percent === null ? 'indeterminate' : ''} />
        </div>
      )}
      {log.length > 1 && (
        <>
          <button className="job-log-toggle" aria-expanded={showLog} onClick={() => setShowLog(!showLog)}>
            <ChevronRight size={13} className={showLog ? 'tree-toggle open' : 'tree-toggle'} /> Steps ({log.length})
          </button>
          {showLog && (
            <ol className="job-log">
              {log.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}
