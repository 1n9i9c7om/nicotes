import type { ListItem } from './blocks';

/**
 * Edits of list items in a page's Markdown, used by interactive layouts (the checklist view).
 * Each takes the item as found by `pageBlocks` on the same text and returns the new text;
 * nested items move and disappear with their parent.
 */

const PREFIX = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(\[[ xX]\](?:\s+|$))?/;

function splitLines(markdown: string) {
  return markdown.split('\n');
}

/** Ticks or unticks an item; a plain item becomes a task item. */
export function setItemChecked(markdown: string, item: ListItem, checked: boolean): string {
  const lines = splitLines(markdown);
  lines[item.line] = lines[item.line]!.replace(
    PREFIX,
    (_m, indent: string, marker: string, space: string) => `${indent}${marker}${space}[${checked ? 'x' : ' '}] `,
  );
  return lines.join('\n');
}

/** Replaces an item's text (first line only; continuation lines are dropped). */
export function setItemText(markdown: string, item: ListItem, text: string): string {
  const lines = splitLines(markdown);
  const prefix = PREFIX.exec(lines[item.line]!)?.[0] ?? `${item.indent}- `;
  let next = item.line + 1;
  // Continuation lines belong to the old text; nested items stay.
  while (next <= item.end && !/^\s*([-*+]|\d{1,9}[.)])\s/.test(lines[next]!)) next++;
  lines.splice(item.line, next - item.line, `${prefix}${text.replace(/\s*\n\s*/g, ' ').trim()}`);
  return lines.join('\n');
}

/** Removes an item with its nested items. */
export function removeItem(markdown: string, item: ListItem): string {
  const lines = splitLines(markdown);
  lines.splice(item.line, item.end - item.line + 1);
  return lines.join('\n');
}

/** Adds an item after `after` (at its level), or as the first item of an empty spot at `line`. */
export function addItem(
  markdown: string,
  after: ListItem,
  text: string,
  options: { checkbox?: boolean } = {},
): string {
  const lines = splitLines(markdown);
  const marker = after.ordered ? `${Number.parseInt(after.marker, 10) + 1}${after.marker.slice(-1)}` : after.marker;
  const box = (options.checkbox ?? after.checked !== null) ? '[ ] ' : '';
  lines.splice(after.end + 1, 0, `${after.indent}${marker} ${box}${text.replace(/\s*\n\s*/g, ' ').trim()}`);
  return lines.join('\n');
}

/** Ticks or unticks all given items (in one edit, so it can be undone at once). */
export function setAllChecked(markdown: string, items: ListItem[], checked: boolean): string {
  return items.reduce((md, item) => (item.checked === null ? md : setItemChecked(md, item, checked)), markdown);
}

/**
 * Moves an item (with its nested items) before or after another item, taking over the
 * target's indentation so it can change lists or levels.
 */
export function moveItem(markdown: string, item: ListItem, target: ListItem, place: 'before' | 'after'): string {
  if (target.line >= item.line && target.line <= item.end) return markdown; // into itself
  const lines = splitLines(markdown);
  const shift = target.indent.length - item.indent.length;
  const moved = lines.slice(item.line, item.end + 1).map((line) => {
    if (!line.trim()) return line;
    if (shift > 0) return ' '.repeat(shift) + line;
    return line.slice(Math.min(-shift, /^\s*/.exec(line)![0].length));
  });
  const anchor = place === 'before' ? target.line : target.end + 1;
  // Insert first, then remove the original (adjusting for whether it sat before the anchor).
  lines.splice(anchor, 0, ...moved);
  const from = item.line < anchor ? item.line : item.line + moved.length;
  lines.splice(from, moved.length);
  return lines.join('\n');
}
