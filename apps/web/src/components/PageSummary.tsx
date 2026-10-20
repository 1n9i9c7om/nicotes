import { Loader2, RotateCcw, Sparkles, X } from 'lucide-react';
import { useDeleteSummary, usePageSummary, type useSummarize } from '../lib/queries';

/**
 * The page's AI summary, shown between tags and text. Hidden until one is made (page menu →
 * "Summarize with AI"); a changed page marks it as outdated instead of silently keeping it.
 */
export function PageSummary({
  pageId,
  version,
  summarize,
}: {
  pageId: string;
  version: number;
  summarize: ReturnType<typeof useSummarize>;
}) {
  const summary = usePageSummary(pageId, version);
  const remove = useDeleteSummary(pageId);
  const data = summary.data;

  if (!data) {
    if (summarize.isPending) {
      return (
        <div className="page-summary pending" role="status">
          <Loader2 size={14} className="spin" /> Summarizing…
        </div>
      );
    }
    return summarize.error ? <p className="error page-summary-error">{summarize.error.message}</p> : null;
  }

  return (
    <aside className={data.stale ? 'page-summary stale' : 'page-summary'} aria-label="AI summary">
      <Sparkles size={14} className="page-summary-icon" />
      <p>{data.summary}</p>
      <div className="page-summary-actions">
        {data.stale && <span className="page-summary-note">The page changed since</span>}
        <button
          className="icon-btn"
          title="Summarize again"
          aria-label="Summarize again"
          disabled={summarize.isPending}
          onClick={() => summarize.mutate()}
        >
          {summarize.isPending ? <Loader2 size={14} className="spin" /> : <RotateCcw size={14} />}
        </button>
        <button className="icon-btn" title="Remove summary" aria-label="Remove summary" onClick={() => remove.mutate()}>
          <X size={14} />
        </button>
      </div>
      {summarize.error && <p className="error">{summarize.error.message}</p>}
    </aside>
  );
}
