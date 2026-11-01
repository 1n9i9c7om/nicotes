import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { ChartSeries, TableChart } from '@nicotes/shared';

/**
 * Small multiples: one chart per numeric column, each on its own axis (columns usually have
 * different units, and two scales on one chart mislead). Dates get a line, anything else
 * bars. Hover (or touch) shows the value; the table stays below as the exact view.
 */

const HEIGHT = 150;
const PAD = { top: 12, right: 12, bottom: 22, left: 44 };

/** "2026-11-04", "2026-11", "4.11.2026" as a time; null otherwise. */
function timeOf(label: string): number | null {
  let m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(label);
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3] ?? 1));
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})/.exec(label);
  if (m) return Date.UTC(Number(m[3]!.length === 2 ? `20${m[3]}` : m[3]), Number(m[2]) - 1, Number(m[1]));
  return null;
}

const format = (value: number) => {
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return value.toLocaleString(undefined, { maximumFractionDigits: digits });
};

/** Round, readable axis ends around the data. */
function niceRange(min: number, max: number, fromZero: boolean): [number, number] {
  if (fromZero) {
    min = Math.min(0, min);
    max = Math.max(0, max);
  }
  if (min === max) return [min - 1, max + 1];
  const step = 10 ** Math.floor(Math.log10(max - min)) / 2;
  return [Math.floor(min / step) * step, Math.ceil(max / step) * step];
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry!.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

function SeriesChart({ chart, series, slot }: { chart: TableChart; series: ChartSeries; slot: number }) {
  const [box, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const bars = chart.kind === 'category';
  const points = series.values.map((v, i) => ({ i, v, t: timeOf(chart.x[i]!) })).filter((p) => p.v !== null) as {
    i: number;
    v: number;
    t: number | null;
  }[];
  const values = points.map((p) => p.v);
  const [lo, hi] = niceRange(Math.min(...values), Math.max(...values), bars);
  const plotW = Math.max(width - PAD.left - PAD.right, 10);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const n = chart.x.length;
  // Dated rows are placed by their date when every row has one, else evenly.
  const times = chart.x.map(timeOf);
  const byTime = !bars && times.every((t) => t !== null) && times[0] !== times.at(-1);
  const [t0, t1] = byTime ? [Math.min(...(times as number[])), Math.max(...(times as number[]))] : [0, 0];
  const xOf = (i: number) =>
    bars ? PAD.left + (plotW / n) * (i + 0.5) : PAD.left + (byTime ? ((times[i]! - t0) / (t1 - t0)) * plotW : n > 1 ? (plotW * i) / (n - 1) : plotW / 2);
  const yOf = (v: number) => PAD.top + plotH - ((v - lo) / (hi - lo)) * plotH;
  const ticks = [lo, (lo + hi) / 2, hi];
  const last = points.at(-1);
  const unit = series.unit ? ` ${series.unit}` : '';

  // A line through the known values; gaps (empty cells) break it.
  let path = '';
  series.values.forEach((v, i) => {
    if (v === null) return;
    path += `${i > 0 && series.values[i - 1] !== null ? 'L' : 'M'}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`;
  });

  const nearest = (e: PointerEvent<SVGSVGElement>) => {
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
    let best: number | null = null;
    for (const p of points) if (best === null || Math.abs(xOf(p.i) - x) < Math.abs(xOf(best) - x)) best = p.i;
    setHover(best);
  };
  const shown = hover ?? null;
  const barW = Math.max(Math.min(plotW / n - 2, 28), 2);

  return (
    <figure className="chart-card">
      <figcaption>
        <span className="chart-title">{series.name}</span>
        {series.unit && <span className="chart-unit">{series.unit}</span>}
        {last && (
          <span className="chart-latest">
            {bars ? 'max' : 'last'} {format(bars ? Math.max(...values) : last.v)}
            {unit}
          </span>
        )}
      </figcaption>
      <div className="chart-plot" ref={box}>
        {width > 0 && (
          <svg
            width={width}
            height={HEIGHT}
            role="img"
            aria-label={`${series.name}${unit ? ` (${series.unit})` : ''}: ${points.length} values from ${format(Math.min(...values))} to ${format(Math.max(...values))}`}
            style={{ '--series': `var(--series-${(slot % 8) + 1})` } as React.CSSProperties}
            onPointerMove={nearest}
            onPointerDown={nearest}
            onPointerLeave={() => setHover(null)}
          >
            {ticks.map((t) => (
              <g key={t} className="chart-grid">
                <line x1={PAD.left} x2={PAD.left + plotW} y1={yOf(t)} y2={yOf(t)} />
                <text x={PAD.left - 6} y={yOf(t)} dy="0.35em" textAnchor="end">
                  {format(t)}
                </text>
              </g>
            ))}
            <text className="chart-axis" x={PAD.left} y={HEIGHT - 6} textAnchor="start">
              {chart.x[0]}
            </text>
            {n > 1 && (
              <text className="chart-axis" x={PAD.left + plotW} y={HEIGHT - 6} textAnchor="end">
                {chart.x.at(-1)}
              </text>
            )}
            {bars ? (
              points.map((p) => {
                const top = Math.min(yOf(p.v), yOf(0));
                const h = Math.max(Math.abs(yOf(p.v) - yOf(0)), 1);
                return (
                  <rect
                    key={p.i}
                    className={shown === p.i ? 'chart-bar active' : 'chart-bar'}
                    x={xOf(p.i) - barW / 2}
                    y={top}
                    width={barW}
                    height={h}
                    rx={Math.min(4, barW / 2)}
                  />
                );
              })
            ) : (
              <>
                <path className="chart-line" d={path} />
                {/* Single values between gaps would be invisible as a line. */}
                {points
                  .filter((p) => series.values[p.i - 1] == null && series.values[p.i + 1] == null)
                  .map((p) => (
                    <circle key={p.i} className="chart-dot" cx={xOf(p.i)} cy={yOf(p.v)} r={3} />
                  ))}
              </>
            )}
            {shown !== null && series.values[shown] != null && (
              <g className="chart-hover">
                {!bars && <line x1={xOf(shown)} x2={xOf(shown)} y1={PAD.top} y2={PAD.top + plotH} />}
                {!bars && <circle cx={xOf(shown)} cy={yOf(series.values[shown]!)} r={4.5} />}
              </g>
            )}
          </svg>
        )}
        {shown !== null && series.values[shown] != null && (
          <div className="chart-tip" style={{ left: Math.min(Math.max(xOf(shown), 60), width - 60) }} role="status">
            <span>{chart.x[shown]}</span>
            <strong>
              {format(series.values[shown]!)}
              {unit}
            </strong>
          </div>
        )}
      </div>
    </figure>
  );
}

export function TableCharts({ chart, title }: { chart: TableChart; title?: string }) {
  return (
    <section className="chart-group">
      {title && <h3 className="chart-group-title">{title}</h3>}
      <div className="chart-grid-cards">
        {chart.series.map((s, i) => (
          <SeriesChart key={`${s.name}-${i}`} chart={chart} series={s} slot={i} />
        ))}
      </div>
    </section>
  );
}
