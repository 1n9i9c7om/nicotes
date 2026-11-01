import { z } from 'zod';
import { dateSchema } from './history';
import { addToSection, appendBlock } from './sections';

/**
 * Task list items (`- [ ] Buy flour`) collected across pages. Tasks stay plain Markdown in
 * their pages; the server reads them on demand and edits single lines when one is ticked off.
 *
 * Due dates are written like Obsidian's Tasks plugin does, `📅 2026-10-25`; `due:2026-10-25`
 * and `@2026-10-25` are understood as well.
 */
export const DUE_TOKEN = /(?:📅\s*|\bdue:|(?<![\w.])@)(\d{4}-\d{2}-\d{2})(?!\d)/gu;

const TASK_LINE = /^(\s*)([-*+]|\d+[.)])\s+\[([ xX])\]\s+(.*)$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/;

export interface TaskItem {
  /** 0-based line number in the page's Markdown. */
  line: number;
  /** The line as stored, to detect that it changed in the meantime. */
  raw: string;
  /** Task text without checkbox and due date. */
  text: string;
  done: boolean;
  /** YYYY-MM-DD. */
  due: string | null;
  /** Nearest heading above the task. */
  heading: string | null;
  /** Indentation level (0 for top-level tasks). */
  depth: number;
}

const stripDue = (text: string) => text.replace(DUE_TOKEN, '').replace(/\s{2,}/g, ' ').trim();

/** All tasks of a page, outside code blocks. */
export function parseTasks(markdown: string): TaskItem[] {
  const tasks: TaskItem[] = [];
  let fence: string | null = null;
  let heading: string | null = null;
  markdown.split('\n').forEach((line, index) => {
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return;
    }
    if (marker) {
      fence = marker;
      return;
    }
    const h = HEADING.exec(line);
    if (h) {
      heading = h[1] || null;
      return;
    }
    const m = TASK_LINE.exec(line);
    if (!m || !m[4]!.trim()) return; // "- [ ] " placeholders are no tasks yet
    const body = m[4]!;
    const due = [...body.matchAll(DUE_TOKEN)].at(-1)?.[1] ?? null;
    tasks.push({
      line: index,
      raw: line,
      text: stripDue(body),
      done: m[3] !== ' ',
      due,
      heading,
      depth: Math.floor(m[1]!.replace(/\t/g, '  ').length / 2),
    });
  });
  return tasks;
}

/** Rewrites a task line: ticks it off (or not) and/or sets or clears its due date. */
export function updateTaskLine(raw: string, change: { done?: boolean; due?: string | null }): string {
  const m = TASK_LINE.exec(raw);
  if (!m) return raw;
  const [, indent, bullet, box, body] = m as unknown as [string, string, string, string, string];
  const mark = change.done === undefined ? box : change.done ? 'x' : ' ';
  let text = body;
  if (change.due !== undefined) {
    text = stripDue(text);
    if (change.due) text = `${text} 📅 ${change.due}`;
  }
  return `${indent}${bullet} [${mark}] ${text}`;
}

export const taskUpdateSchema = z
  .object({
    pageId: z.string().max(64),
    line: z.number().int().min(0),
    /** The line the client saw; the update is refused if the page changed there. */
    raw: z.string().max(20_000),
    done: z.boolean().optional(),
    due: dateSchema.nullable().optional(),
  })
  .refine((t) => t.done !== undefined || t.due !== undefined, 'Nothing to change');
export type TaskUpdate = z.infer<typeof taskUpdateSchema>;

export const taskCreateSchema = z.object({
  pageId: z.string().max(64),
  text: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .transform((t) => t.replace(/\s*\n\s*/g, ' ')),
  due: dateSchema.nullable().optional(),
});
export type TaskCreate = z.input<typeof taskCreateSchema>;

const PLACEHOLDER = /^\s*[-*+] \[ \]\s*$/;
const TASKS_HEADING = /^ {0,3}#{1,6}\s+(tasks?|to-?dos?|aufgaben)\s*#*\s*$/i;

/**
 * Adds an open task to a page: into an empty placeholder task (as daily notes start with), else
 * at the end of a "Tasks"/"Todo" section, else at the end of the page.
 */
export function appendTask(markdown: string, text: string, due?: string | null): string {
  const body = `${text}${due ? ` 📅 ${due}` : ''}`;
  const lines = markdown.split('\n');
  const placeholder = lines.findIndex((l) => PLACEHOLDER.test(l));
  if (placeholder >= 0) {
    lines[placeholder] = lines[placeholder]!.replace(/\[ \]\s*$/, `[ ] ${body}`);
    return lines.join('\n');
  }
  const task = `- [ ] ${body}`;
  const last = markdown.replace(/\s+$/, '').split('\n').at(-1) ?? '';
  return addToSection(markdown, TASKS_HEADING, task) ?? appendBlock(markdown, task, /^\s*[-*+] \[[ xX]\]/.test(last));
}

export type TaskStatus = 'open' | 'done' | 'all';

/** A task with the page it lives in, as listed by GET /api/tasks. */
export interface PageTask extends TaskItem {
  pageId: string;
  pageTitle: string;
  notebookId: string;
  /** Page version the line numbers refer to. */
  version: number;
  pageUpdatedAt: number;
}

/** [[target|label]] and [text](url) in task text. */
export const TASK_INLINE_LINK = /\[\[([^[\]|\n]+?)(?:\|([^[\]\n]+?))?\]\]|\[([^\]\n]*)\]\([^)\n]*\)/g;
/** Drops bold, strike-through and code markers. */
export const stripTaskMarkup = (text: string) => text.replace(/\*\*|__|~~|`/g, '');
/** Task text as plain text: links become their label, Markdown markers are dropped. */
export const taskPlainText = (text: string) =>
  stripTaskMarkup(text.replace(TASK_INLINE_LINK, (_m, target?: string, label?: string, linkText?: string) => (label ?? target ?? linkText ?? '').trim()));
