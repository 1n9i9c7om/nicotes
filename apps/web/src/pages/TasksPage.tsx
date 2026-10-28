import { Fragment, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { CalendarDays, ListChecks, Plus, Search, X } from 'lucide-react';
import { resolveWikilink, type PageTask, type TaskStatus } from '@nicotes/shared';
import { localDate, useDailyNote } from '../lib/daily';
import { useLinkContext } from '../lib/links';
import { useAddTask, useNotebooks, useSettings, useTasks, useUpdateTask } from '../lib/queries';
import { useLocalState } from '../lib/storage';
import { BUCKET_LABELS, BUCKETS, dueBucket, dueLabel, type Bucket } from '../lib/tasks';
import { displayTitle } from '../lib/tree';

type Grouping = 'date' | 'page';

const keyOf = (t: PageTask) => `${t.pageId}:${t.line}`;

export function TasksPage() {
  const tasks = useTasks();
  const notebooks = useNotebooks();
  const update = useUpdateTask();
  const settings = useSettings();
  const excluded = settings.data?.tasks.excludeTags ?? [];
  const [view, setView] = useLocalState<TaskStatus>('nicotes.tasksView', 'open');
  const [grouping, setGrouping] = useLocalState<Grouping>('nicotes.tasksGrouping', 'date');
  const [notebookId, setNotebookId] = useLocalState<string | null>('nicotes.tasksNotebook', null);
  const [filter, setFilter] = useState('');
  // Tasks ticked off (or reopened) here stay in place until the view changes, so a misclick
  // can be undone where it happened.
  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  const today = localDate();

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return (tasks.data ?? []).filter((t) => {
      if (notebookId && t.notebookId !== notebookId) return false;
      if (needle && !`${t.text} ${t.pageTitle}`.toLowerCase().includes(needle)) return false;
      if (touched.has(keyOf(t))) return true;
      return view === 'all' || (view === 'open') !== t.done;
    });
  }, [tasks.data, notebookId, filter, view, touched]);

  const groups = useMemo(() => {
    const byDue = (a: PageTask, b: PageTask) =>
      (a.due ?? '9999').localeCompare(b.due ?? '9999') || b.pageUpdatedAt - a.pageUpdatedAt || a.line - b.line;
    if (grouping === 'page') {
      const map = new Map<string, PageTask[]>();
      for (const t of visible) map.set(t.pageId, [...(map.get(t.pageId) ?? []), t]);
      return [...map.values()]
        .map((list) => list.sort((a, b) => a.line - b.line))
        .sort((a, b) => byDue([...a].sort(byDue)[0]!, [...b].sort(byDue)[0]!))
        .map((list) => ({ key: list[0]!.pageId, page: list[0]!, label: null as string | null, bucket: null as Bucket | null, tasks: list }));
    }
    const map = new Map<Bucket, PageTask[]>();
    for (const t of visible) {
      const bucket = t.done && !touched.has(keyOf(t)) ? 'done' : dueBucket(t.due, today);
      map.set(bucket, [...(map.get(bucket) ?? []), t]);
    }
    return BUCKETS.filter((b) => map.has(b)).map((b) => ({
      key: b,
      page: null,
      label: BUCKET_LABELS[b],
      bucket: b,
      tasks: map.get(b)!.sort(byDue),
    }));
  }, [visible, grouping, today, touched]);

  const change = (t: PageTask, patch: { done?: boolean; due?: string | null }) => {
    if (patch.done !== undefined) setTouched((s) => new Set(s).add(keyOf(t)));
    update.mutate({ pageId: t.pageId, line: t.line, raw: t.raw, ...patch });
  };
  const switchView = (next: TaskStatus) => {
    setView(next);
    setTouched(new Set());
  };
  const openCount = (tasks.data ?? []).filter((t) => !t.done).length;

  return (
    <div className="content tasks-page">
      <header className="content-header">
        <h1>
          <ListChecks size={26} /> Tasks
        </h1>
        <p className="muted">Every checkbox from every page, in one list. Ticking one off here updates its page.</p>
      </header>

      <AddTask />

      <div className="tasks-toolbar">
        <div className="segmented" role="group" aria-label="Show">
          {(['open', 'done', 'all'] as const).map((v) => (
            <button key={v} className={view === v ? 'active' : ''} aria-pressed={view === v} onClick={() => switchView(v)}>
              {v === 'open' ? `Open${openCount ? ` · ${openCount}` : ''}` : v === 'done' ? 'Done' : 'All'}
            </button>
          ))}
        </div>
        <div className="segmented" role="group" aria-label="Group by">
          <button className={grouping === 'date' ? 'active' : ''} aria-pressed={grouping === 'date'} onClick={() => setGrouping('date')}>
            By date
          </button>
          <button className={grouping === 'page' ? 'active' : ''} aria-pressed={grouping === 'page'} onClick={() => setGrouping('page')}>
            By page
          </button>
        </div>
        <select value={notebookId ?? ''} onChange={(e) => setNotebookId(e.target.value || null)} aria-label="Notebook">
          <option value="">All notebooks</option>
          {notebooks.data?.map((n) => (
            <option key={n.id} value={n.id}>
              {n.title}
            </option>
          ))}
        </select>
        <label className="tasks-filter">
          <Search size={15} />
          <input placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          {filter && (
            <button className="icon-btn" aria-label="Clear filter" onClick={() => setFilter('')}>
              <X size={14} />
            </button>
          )}
        </label>
      </div>

      {excluded.length > 0 && (
        <p className="tasks-hidden">
          Checklists in pages tagged {excluded.map((t) => `#${t}`).join(', ')} are left out ·{' '}
          <Link to="/settings#tasks">change</Link>
        </p>
      )}

      {update.error && (
        <p className="error" role="alert">
          {update.error.message}. The list was reloaded, please try again.
        </p>
      )}

      {tasks.isPending ? (
        <div className="content-loading" aria-busy="true" />
      ) : groups.length === 0 ? (
        <div className="empty-state">
          <ListChecks size={28} className="muted" />
          <p className="muted">
            {(tasks.data ?? []).length === 0
              ? 'No tasks yet. Write “- [ ] something” in any page, or add one above.'
              : view === 'open'
                ? 'Nothing open here. Nice!'
                : 'No tasks match.'}
          </p>
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.key} className={`task-group${g.bucket ? ` bucket-${g.bucket}` : ''}`}>
            <h2 className="section-title">
              {g.page ? (
                <Link to={`/p/${g.page.pageId}`}>{displayTitle(g.page.pageTitle)}</Link>
              ) : (
                g.label
              )}
              <span className="task-group-count">{g.tasks.length}</span>
            </h2>
            <ul className="task-list">
              {g.tasks.map((t) => (
                <TaskRow key={keyOf(t)} task={t} today={today} showPage={!g.page} onChange={(patch) => change(t, patch)} />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

function TaskRow({
  task,
  today,
  showPage,
  onChange,
}: {
  task: PageTask;
  today: string;
  showPage: boolean;
  onChange: (patch: { done?: boolean; due?: string | null }) => void;
}) {
  const bucket = task.done ? 'done' : dueBucket(task.due, today);
  return (
    <li className={task.done ? 'task-row done' : 'task-row'} style={{ '--depth': Math.min(task.depth, 4) } as CSSProperties}>
      <input
        type="checkbox"
        className="task-check"
        checked={task.done}
        aria-label={`${task.done ? 'Reopen' : 'Complete'} “${plainText(task.text)}”`}
        onChange={() => onChange({ done: !task.done })}
      />
      <div className="task-main">
        <span className="task-text">
          <TaskText text={task.text} notebookId={task.notebookId} />
        </span>
        {showPage && (
          <span className="task-where">
            <Link to={`/p/${task.pageId}`}>{displayTitle(task.pageTitle)}</Link>
            {task.heading && <> › {task.heading}</>}
          </span>
        )}
      </div>
      <DuePicker due={task.due} today={today} bucket={bucket} onChange={(due) => onChange({ due })} />
    </li>
  );
}

/** A due date chip that opens the browser's date picker; empty dates show a faint icon on hover. */
export function DuePicker({
  due,
  today,
  bucket,
  onChange,
}: {
  due: string | null;
  today: string;
  bucket?: Bucket;
  onChange: (due: string | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <span className={`due-picker${due ? ' set' : ''}${bucket ? ` due-${bucket}` : ''}`}>
      <button
        type="button"
        className="due-chip"
        title={due ? `Due ${due}` : 'Set a due date'}
        onClick={() => {
          try {
            input.current?.showPicker();
          } catch {
            input.current?.focus();
          }
        }}
      >
        <CalendarDays size={13} />
        {due && dueLabel(due, today)}
      </button>
      {due && (
        <button type="button" className="icon-btn due-clear" aria-label="Remove due date" onClick={() => onChange(null)}>
          <X size={12} />
        </button>
      )}
      <input
        ref={input}
        type="date"
        className="due-input"
        tabIndex={-1}
        aria-label="Due date"
        value={due ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
      />
    </span>
  );
}

const INLINE = /\[\[([^[\]|\n]+?)(?:\|([^[\]\n]+?))?\]\]|\[([^\]\n]*)\]\([^)\n]*\)/g;
const plain = (text: string) => text.replace(/\*\*|__|~~|`/g, '');
const plainText = (text: string) =>
  plain(text.replace(INLINE, (_m, target?: string, label?: string, linkText?: string) => (label ?? target ?? linkText ?? '').trim()));

/** Task text with [[links]] clickable and Markdown syntax dropped. */
function TaskText({ text, notebookId }: { text: string; notebookId: string }) {
  const ctx = useLinkContext();
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    parts.push(plain(text.slice(last, m.index)));
    if (m[1]) {
      const page = resolveWikilink(ctx, m[1].trim(), notebookId);
      const label = (m[2] ?? m[1]).trim();
      parts.push(
        page ? (
          <Link key={m.index} to={`/p/${page.id}`} className="task-link">
            {label}
          </Link>
        ) : (
          <span key={m.index} className="task-link missing">
            {label}
          </span>
        ),
      );
    } else {
      parts.push(plain(m[3] ?? ''));
    }
    last = m.index + m[0].length;
  }
  parts.push(plain(text.slice(last)));
  return <>{parts.map((p, i) => (typeof p === 'string' ? <Fragment key={`t${i}`}>{p}</Fragment> : p))}</>;
}

function AddTask() {
  const dailyNote = useDailyNote();
  const add = useAddTask();
  const [text, setText] = useState('');
  const [due, setDue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const pageId = await dailyNote();
      await add.mutateAsync({ pageId, text, due });
      setText('');
      setDue(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="task-add" onSubmit={submit}>
      <Plus size={18} className="muted" />
      <input
        value={text}
        maxLength={2000}
        placeholder="Add a task to today’s journal note…"
        aria-label="New task"
        onChange={(e) => setText(e.target.value)}
      />
      <DuePicker due={due} today={localDate()} onChange={setDue} />
      <button className="btn btn-primary btn-sm" disabled={busy || !text.trim()}>
        Add
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
