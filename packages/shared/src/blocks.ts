/**
 * A page split into blocks (headings, lists, paragraphs…) with their line ranges, so layouts
 * can show parts of a page in their own way and turn interactions back into line edits.
 *
 * Every block gets a key from its kind, the headings above it and its position among blocks
 * of that kind under those headings (`list:Ingredients:0`). Keys survive edits inside a block
 * and edits elsewhere in the page, so a stored layout keeps pointing at the right parts.
 */

export interface ListItem {
  /** First line of the item (0-based). */
  line: number;
  /** Last line that belongs to it, nested items included. */
  end: number;
  /** Nesting level, 0 for top-level items. */
  depth: number;
  /** Leading whitespace of the marker line. */
  indent: string;
  /** `-`, `*`, `+`, `1.` or `1)`. */
  marker: string;
  ordered: boolean;
  /** Checkbox state, or null for a plain item. */
  checked: boolean | null;
  /** Item text without marker and checkbox (continuation lines joined with spaces). */
  text: string;
}

interface BlockBase {
  key: string;
  /** Heading texts above the block, outermost first. */
  heading: string[];
  start: number;
  end: number;
}

export type PageBlock =
  | (BlockBase & { kind: 'heading'; level: number; text: string })
  | (BlockBase & { kind: 'paragraph' | 'quote' | 'code' | 'table' | 'image'; text: string })
  | (BlockBase & { kind: 'list'; ordered: boolean; items: ListItem[] });

export type BlockKind = PageBlock['kind'];

/** A block before its key is assigned (`Omit` per union member). */
type Draft = PageBlock extends infer B ? (B extends PageBlock ? Omit<B, 'key'> : never) : never;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const CHECKBOX = /^\[([ xX])\](?:\s+|$)/;
const IMAGE_LINE = /^\s*!\[[^\]]*\]\([^)]*\)\s*$/;

const isBlank = (line: string) => !line.trim();
const indentWidth = (s: string) => s.replace(/\t/g, '    ').length;

export function pageBlocks(markdown: string): PageBlock[] {
  const lines = markdown.split('\n');
  const blocks: Draft[] = [];
  const path: string[] = [];
  const heading = () => path.filter(Boolean);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line)?.[1];
    if (fence) {
      const start = i;
      const body: string[] = [];
      for (i++; i < lines.length; i++) {
        const close = FENCE.exec(lines[i]!)?.[1];
        if (close && close[0] === fence[0] && close.length >= fence.length) break;
        body.push(lines[i]!);
      }
      blocks.push({ kind: 'code', heading: heading(), start, end: Math.min(i, lines.length - 1), text: body.join('\n') });
      i++;
      continue;
    }

    const h = HEADING.exec(line);
    if (h) {
      const level = h[1]!.length;
      path.length = Math.min(path.length, level - 1);
      path[level - 1] = h[2]!;
      blocks.push({ kind: 'heading', heading: heading().slice(0, -1), start: i, end: i, level, text: h[2]! });
      i++;
      continue;
    }

    if (ITEM.test(line)) {
      const start = i;
      const items: ListItem[] = [];
      const indents: number[] = [];
      let last = i;
      while (i < lines.length) {
        const current = lines[i]!;
        const m = ITEM.exec(current);
        if (m) {
          const width = indentWidth(m[1]!);
          // Switching between bullets and numbers at the top level starts a new list.
          if (items.length && width <= indents[0]! && /\d/.test(m[2]!) !== items[0]!.ordered) break;
          while (indents.length && width < indents.at(-1)!) indents.pop();
          if (!indents.length || width > indents.at(-1)!) indents.push(width);
          const box = CHECKBOX.exec(m[3]!);
          items.push({
            line: i,
            end: i,
            depth: indents.length - 1,
            indent: m[1]!,
            marker: m[2]!,
            ordered: /\d/.test(m[2]!),
            checked: box ? box[1] !== ' ' : null,
            text: (box ? m[3]!.slice(box[0].length) : m[3]!).trim(),
          });
          last = i++;
          continue;
        }
        if (!isBlank(current)) {
          // A non-item line continues the last item unless it starts something else.
          if (HEADING.test(current) || FENCE.test(current) || /^\s*>/.test(current)) break;
          if (isBlank(lines[i - 1]!) && indentWidth(/^\s*/.exec(current)![0]) < 2) break;
          items.at(-1)!.text = `${items.at(-1)!.text} ${current.trim()}`.trim();
          last = i++;
          continue;
        }
        // Blank lines continue the list only if another item or indented text follows.
        let next = i;
        while (next < lines.length && isBlank(lines[next]!)) next++;
        const after = lines[next];
        if (after !== undefined && (ITEM.test(after) || indentWidth(/^\s*/.exec(after)![0]) >= 2)) {
          i = next;
          continue;
        }
        break;
      }
      items.forEach((item, n) => {
        const following = items.slice(n + 1).find((other) => other.depth <= item.depth);
        let end = following ? following.line - 1 : last;
        while (end > item.line && isBlank(lines[end]!)) end--;
        item.end = end;
      });
      blocks.push({ kind: 'list', heading: heading(), start, end: last, ordered: items[0]!.ordered, items });
      continue;
    }

    const start = i;
    const kind = /^\s*>/.test(line)
      ? 'quote'
      : /^\s*\|.*\|/.test(line)
        ? 'table'
        : IMAGE_LINE.test(line)
          ? 'image'
          : 'paragraph';
    const body: string[] = [];
    while (i < lines.length) {
      const current = lines[i]!;
      if (isBlank(current) || HEADING.test(current) || FENCE.test(current)) break;
      if (kind === 'paragraph' && (ITEM.test(current) || /^\s*>/.test(current) || IMAGE_LINE.test(current))) break;
      if (kind === 'quote' && !/^\s*>/.test(current)) break;
      if (kind === 'table' && !/^\s*\|/.test(current)) break;
      if (kind === 'image' && body.length) break;
      body.push(kind === 'quote' ? current.replace(/^\s*>\s?/, '') : current);
      i++;
    }
    blocks.push({ kind, heading: heading(), start, end: i - 1, text: kind === 'paragraph' ? body.map((l) => l.trim()).join(' ') : body.join('\n') });
  }

  const seen = new Map<string, number>();
  return blocks.map((block) => {
    const base = `${block.kind}:${block.heading.join('/')}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { ...block, key: `${base}:${n}` } as PageBlock;
  });
}

/** Blocks for the given keys, in page order; unknown keys are skipped. */
export function blocksByKey(blocks: PageBlock[], keys: string[]): PageBlock[] {
  const wanted = new Set(keys);
  return blocks.filter((b) => wanted.has(b.key));
}
