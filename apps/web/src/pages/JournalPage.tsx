import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { CalendarDays, ChevronLeft, ChevronRight, Settings as SettingsIcon } from 'lucide-react';
import { localDate, useOpenDailyNote } from '../lib/daily';
import { useDailyRange, usePages } from '../lib/queries';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Month calendar of daily notes; clicking a day opens (or creates) its note. */
export function JournalPage() {
  const today = localDate();
  const [month, setMonth] = useState(() => today.slice(0, 7)); // YYYY-MM
  const [y, m] = month.split('-').map(Number) as [number, number];
  const first = new Date(y, m - 1, 1);
  const days = new Date(y, m, 0).getDate();
  const from = `${month}-01`;
  const to = `${month}-${String(days).padStart(2, '0')}`;
  const entries = useDailyRange(from, to);
  const pages = usePages();
  const openDaily = useOpenDailyNote();
  const [busy, setBusy] = useState<string | null>(null);

  const byDate = useMemo(() => new Map(entries.data?.map((e) => [e.date, e.pageId])), [entries.data]);
  const preview = (pageId: string | undefined) => pages.data?.find((p) => p.id === pageId)?.updatedAt;

  // Monday-first grid with leading blanks.
  const lead = (first.getDay() + 6) % 7;
  const cells: (string | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`),
  ];

  const shift = (delta: number) => {
    const d = new Date(y, m - 1 + delta, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  };

  const open = async (date: string) => {
    setBusy(date);
    try {
      await openDaily(date);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="content journal">
      <header className="content-header notebook-header">
        <div className="notebook-heading">
          <h1>
            <CalendarDays size={26} /> Journal
          </h1>
          <p className="muted">One note per day, filed as Journal › year › month. Click a day to open or start it.</p>
        </div>
        <div className="header-actions">
          <button className="btn btn-primary" onClick={() => void open(today)} disabled={busy === today}>
            Today
          </button>
          <Link className="icon-btn" to="/settings#daily" aria-label="Daily note settings" title="Daily note settings">
            <SettingsIcon size={16} />
          </Link>
        </div>
      </header>

      <section className="calendar">
        <div className="calendar-head">
          <button className="icon-btn" aria-label="Previous month" onClick={() => shift(-1)}>
            <ChevronLeft size={18} />
          </button>
          <h2>{first.toLocaleDateString('en', { month: 'long', year: 'numeric' })}</h2>
          <button className="icon-btn" aria-label="Next month" onClick={() => shift(1)}>
            <ChevronRight size={18} />
          </button>
          {month !== today.slice(0, 7) && (
            <button className="btn btn-sm" onClick={() => setMonth(today.slice(0, 7))}>
              This month
            </button>
          )}
        </div>
        <div className="calendar-grid" role="grid">
          {WEEKDAYS.map((d) => (
            <span key={d} className="calendar-weekday">
              {d}
            </span>
          ))}
          {cells.map((date, i) =>
            date ? (
              <button
                key={date}
                role="gridcell"
                className={[
                  'calendar-day',
                  byDate.has(date) && 'has-note',
                  date === today && 'today',
                  date > today && 'future',
                ]
                  .filter(Boolean)
                  .join(' ')}
                title={byDate.has(date) ? `Open ${date}` : `Start ${date}`}
                disabled={busy === date}
                onClick={() => void open(date)}
              >
                <span className="calendar-num">{Number(date.slice(8))}</span>
                {byDate.has(date) && <span className="calendar-dot" title={`edited ${new Date(preview(byDate.get(date)) ?? 0).toLocaleString()}`} />}
              </button>
            ) : (
              <span key={`blank-${i}`} />
            ),
          )}
        </div>
        <p className="muted calendar-count">
          {entries.data?.length ?? 0} {entries.data?.length === 1 ? 'note' : 'notes'} this month
        </p>
      </section>
    </div>
  );
}
