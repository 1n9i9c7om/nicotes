import { tableChart } from '@nicotes/shared';
import { TableCharts } from './Charts';
import { DocumentLayout } from './DocumentLayout';
import type { LayoutProps } from './types';

/** Charts of the page's number tables on top, the page itself (tables included) below. */
export function DataLayout(props: LayoutProps) {
  const charts = props.spec.tables.flatMap((key) => {
    const block = props.blocks.find((b) => b.key === key);
    const chart = block?.kind === 'table' ? tableChart(block.text) : null;
    return chart && block ? [{ key, chart, title: block.heading.at(-1) }] : [];
  });
  return (
    <div className="layout-data">
      {charts.length ? (
        charts.map((c) => <TableCharts key={c.key} chart={c.chart} title={charts.length > 1 ? c.title : undefined} />)
      ) : (
        <p className="muted">No table with numbers to chart on this page.</p>
      )}
      <DocumentLayout {...props} />
    </div>
  );
}
