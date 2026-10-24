import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent } from 'react';
import { Eye, EyeOff, GripVertical, ListChecks, Pencil, Plus, RotateCcw, X } from 'lucide-react';
import {
  addItem,
  appendTask,
  blocksByKey,
  moveItem,
  removeItem,
  setAllChecked,
  setItemChecked,
  setItemText,
  type ListItem,
} from '@nicotes/shared';
import { useLocalState } from '../../lib/storage';
import { InlineMarkdown } from '../Markdown';
import { isList, plainText, type LayoutProps, type ListBlock } from './types';

type Drop = { target: ListItem; place: 'before' | 'after' };

/**
 * A checklist to work with: tick items, add, edit and remove them, and reorder by dragging
 * (mouse or touch) or with the arrow keys on the handle. Every action edits the page's Markdown.
 */
export function ChecklistLayout({ markdown, blocks, spec, notebookId, onChange }: LayoutProps) {
  const chosen = blocksByKey(blocks, spec.lists).filter(isList);
  const lists = chosen.length ? chosen : blocks.filter(isList);
  const items = lists.flatMap((l) => l.items);
  const done = items.filter((i) => i.checked).length;
  const [hideDone, setHideDone] = useLocalState('nicotes.checklistHideDone', false);
  const [editing, setEditing] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ item: ListItem; drop: Drop | null } | null>(null);
  const dragging = useRef<ListItem | null>(null);
  const rows = useRef(new Map<number, HTMLLIElement>());
  const handles = useRef(new Map<number, HTMLButtonElement>());
  // After a keyboard move the rows re-render: put focus back on the moved item's handle.
  const refocus = useRef<string | null>(null);

  useEffect(() => {
    const text = refocus.current;
    if (text === null) return;
    refocus.current = null;
    const moved = items.find((i) => i.text === text);
    if (moved) handles.current.get(moved.line)?.focus();
  }, [markdown]);

  if (!lists.length) {
    return (
      <div className="layout-empty">
        <ListChecks size={26} className="muted" />
        <p className="muted">No list on this page yet.</p>
        <AddItem label="Start a checklist…" onAdd={(text) => onChange(appendTask(markdown, text))} />
      </div>
    );
  }

  // Hidden: done items, and everything nested under them.
  const hidden = new Set<number>();
  if (hideDone) {
    for (const item of items) {
      if (item.checked && !hidden.has(item.line)) {
        for (const other of items) if (other.line >= item.line && other.line <= item.end) hidden.add(other.line);
      }
    }
  }

  const siblings = (item: ListItem) => items.filter((i) => i.depth === item.depth);
  const moveBy = (item: ListItem, direction: -1 | 1) => {
    const list = siblings(item);
    const target =
      direction < 0 ? list.filter((i) => i.line < item.line).at(-1) : list.find((i) => i.line > item.end);
    if (!target) return;
    refocus.current = item.text;
    onChange(moveItem(markdown, item, target, direction < 0 ? 'before' : 'after'));
  };

  // Where a dragged item would land at this height: before or after the row under the pointer.
  const dropAt = (y: number, dragged: ListItem): Drop | null => {
    for (const item of items) {
      if ((item.line >= dragged.line && item.line <= dragged.end) || hidden.has(item.line)) continue;
      const box = rows.current.get(item.line)?.getBoundingClientRect();
      if (box && y >= box.top && y <= box.bottom) return { target: item, place: y < box.top + box.height / 2 ? 'before' : 'after' };
    }
    return null;
  };
  // The dragged item is read from a ref: pointer events can arrive before React re-renders.
  const onPointerMove = (e: PointerEvent) => {
    const dragged = dragging.current;
    if (!dragged) return;
    const drop = dropAt(e.clientY, dragged);
    setDrag((d) => (d && (drop?.target.line !== d.drop?.target.line || drop?.place !== d.drop?.place) ? { ...d, drop } : d));
    // Near the edges of the scrolling area, scroll along.
    const scroller = (e.target as HTMLElement).closest('.main');
    if (scroller) {
      const box = scroller.getBoundingClientRect();
      if (e.clientY < box.top + 60) scroller.scrollBy(0, -14);
      else if (e.clientY > box.bottom - 60) scroller.scrollBy(0, 14);
    }
  };
  const onPointerUp = (e: PointerEvent) => {
    const dragged = dragging.current;
    dragging.current = null;
    setDrag(null);
    const drop = dragged && dropAt(e.clientY, dragged);
    if (dragged && drop) onChange(moveItem(markdown, dragged, drop.target, drop.place));
  };

  const title = (list: ListBlock, n: number) =>
    list.heading.length ? plainText(list.heading.at(-1)!) : lists.length > 1 ? `List ${n + 1}` : null;

  return (
    <div className={drag ? 'checklist dragging' : 'checklist'}>
      <div className="checklist-progress">
        <div className="checklist-bar" aria-hidden="true">
          <span style={{ width: `${items.length ? (done / items.length) * 100 : 0}%` }} />
        </div>
        <span className="muted">
          {done} of {items.length} done
        </span>
        <span className="checklist-tools">
          <button className="btn btn-sm" aria-pressed={hideDone} onClick={() => setHideDone(!hideDone)}>
            {hideDone ? <Eye size={14} /> : <EyeOff size={14} />} {hideDone ? 'Show done' : 'Hide done'}
          </button>
          {done > 0 && (
            <button className="btn btn-sm" onClick={() => onChange(setAllChecked(markdown, items, false))}>
              <RotateCcw size={14} /> Uncheck all
            </button>
          )}
        </span>
      </div>

      {lists.map((list, n) => {
        const visible = list.items.filter((i) => !hidden.has(i.line));
        const last = [...list.items].reverse().find((i) => i.depth === 0) ?? list.items.at(-1)!;
        return (
          <section key={list.key} className="checklist-group">
            {title(list, n) && <h3 className="checklist-title">{title(list, n)}</h3>}
            <ul className="checklist-items">
              {visible.map((item) => {
                const label = plainText(item.text) || 'Empty item';
                const drop = drag?.drop?.target.line === item.line ? ` drop-${drag.drop.place}` : '';
                const dragged = drag && item.line >= drag.item.line && item.line <= drag.item.end ? ' dragged' : '';
                return (
                  <li
                    key={item.line}
                    ref={(el) => {
                      if (el) rows.current.set(item.line, el);
                      else rows.current.delete(item.line);
                    }}
                    className={`checklist-row${item.checked ? ' done' : ''}${drop}${dragged}`}
                    style={{ paddingLeft: 4 + Math.min(item.depth, 5) * 26 }}
                  >
                    <button
                      ref={(el) => {
                        if (el) handles.current.set(item.line, el);
                        else handles.current.delete(item.line);
                      }}
                      className="checklist-handle"
                      aria-label={`Move “${label}” (arrow keys)`}
                      onPointerDown={(e) => {
                        // preventDefault keeps touch from scrolling, but also stops focusing: focus by hand.
                        e.preventDefault();
                        e.currentTarget.focus();
                        e.currentTarget.setPointerCapture(e.pointerId);
                        dragging.current = item;
                        setDrag({ item, drop: null });
                      }}
                      onPointerMove={onPointerMove}
                      onPointerUp={onPointerUp}
                      onPointerCancel={() => {
                        dragging.current = null;
                        setDrag(null);
                      }}
                      onKeyDown={(e: KeyboardEvent) => {
                        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                          e.preventDefault();
                          moveBy(item, e.key === 'ArrowUp' ? -1 : 1);
                        }
                      }}
                    >
                      <GripVertical size={15} />
                    </button>
                    <input
                      type="checkbox"
                      className="task-check"
                      checked={!!item.checked}
                      aria-label={label}
                      onChange={() => onChange(setItemChecked(markdown, item, !item.checked))}
                    />
                    {editing === item.line ? (
                      <EditText
                        text={item.text}
                        onDone={(text) => {
                          setEditing(null);
                          if (text !== null && text.trim() && text !== item.text) onChange(setItemText(markdown, item, text));
                        }}
                      />
                    ) : (
                      <span className="checklist-text" onDoubleClick={() => setEditing(item.line)}>
                        {item.text ? <InlineMarkdown text={item.text} notebookId={notebookId} /> : <span className="muted">Empty</span>}
                      </span>
                    )}
                    <span className="checklist-actions">
                      <button className="icon-btn" aria-label={`Edit “${label}”`} onClick={() => setEditing(item.line)}>
                        <Pencil size={14} />
                      </button>
                      <button className="icon-btn" aria-label={`Delete “${label}”`} onClick={() => onChange(removeItem(markdown, item))}>
                        <X size={15} />
                      </button>
                    </span>
                  </li>
                );
              })}
              {visible.length === 0 && <li className="checklist-row muted">All done here.</li>}
            </ul>
            <AddItem
              label={`Add to ${title(list, n) ?? 'the list'}…`}
              onAdd={(text) => onChange(addItem(markdown, last, text, { checkbox: true }))}
            />
          </section>
        );
      })}
    </div>
  );
}

function EditText({ text, onDone }: { text: string; onDone: (text: string | null) => void }) {
  const [value, setValue] = useState(text);
  // Enter or Escape unmounts the input, which can still fire a blur: finish only once.
  const finished = useRef(false);
  const finish = (result: string | null) => {
    if (finished.current) return;
    finished.current = true;
    onDone(result);
  };
  return (
    <input
      className="checklist-edit"
      value={value}
      autoFocus
      aria-label="Item text"
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(value);
        else if (e.key === 'Escape') finish(null);
      }}
    />
  );
}

function AddItem({ label, onAdd }: { label: string; onAdd: (text: string) => void }) {
  const [text, setText] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    onAdd(text.trim());
    setText('');
  };
  return (
    <form className="checklist-add" onSubmit={submit}>
      <Plus size={16} className="muted" />
      <input value={text} placeholder={label} aria-label={label} onChange={(e) => setText(e.target.value)} />
    </form>
  );
}
