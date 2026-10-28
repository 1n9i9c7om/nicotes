import { Extension } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/** A run of inline content in one paragraph: text with its link target, or another inline node. */
export interface Segment {
  from: number;
  to: number;
  text: string;
  href: string | null;
}

const CITE_TEXT = /^\s*\d{1,3}(?:\s*[–-]\s*\d{1,3})?\s*$/;
const PLAIN_CITE = /\s*\[\d{1,3}(?:\s*[,–-]\s*\d{1,3})*\]/g;
const SEPARATOR = /^[\s,;]*$/;

const isCite = (s?: Segment) => !!s?.href && /^https?:/i.test(s.href) && CITE_TEXT.test(s.text);

/**
 * The citation markers in a paragraph: links whose text is a number ("[3](https://…)"), the
 * commas between them and the space before them, and plain "[1–14]". Other links stay.
 */
export function citationRanges(segments: Segment[]): [number, number][] {
  const ranges: [number, number][] = [];
  // True while everything so far is hidden (citations at the start of a paragraph or cell).
  let leading = true;
  segments.forEach((s, i) => {
    if (isCite(s)) {
      ranges.push([s.from, s.to]);
      return;
    }
    if (s.href) {
      leading = false;
      return;
    }
    const before = isCite(segments[i - 1]);
    const after = isCite(segments[i + 1]);
    if (before && after && SEPARATOR.test(s.text)) {
      ranges.push([s.from, s.to]);
      return;
    }
    if (before && leading) {
      const head = /^[\s,;]*/.exec(s.text)![0];
      if (head) ranges.push([s.from, s.from + head.length]);
    }
    leading = false;
    if (after) {
      const tail = /[\s,;]*$/.exec(s.text)![0];
      if (tail) ranges.push([s.to - tail.length, s.to]);
    }
    for (const m of s.text.matchAll(PLAIN_CITE)) ranges.push([s.from + m.index, s.from + m.index + m[0].length]);
  });
  return ranges;
}

function decorations(doc: PmNode): DecorationSet {
  const found: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const segments: Segment[] = [];
    node.forEach((child, offset) => {
      const from = pos + 1 + offset;
      const link = child.marks.find((m) => m.type.name === 'link');
      // Other inline nodes (wiki links, images) separate runs of text.
      segments.push({
        from,
        to: from + child.nodeSize,
        text: child.isText ? child.text! : '￼',
        href: child.isText ? ((link?.attrs.href as string | undefined) ?? null) : null,
      });
    });
    // Adjacent text nodes with the same link (split by other marks) count as one.
    const merged = segments.reduce<Segment[]>((list, s) => {
      const last = list.at(-1);
      if (last && last.to === s.from && last.href === s.href && s.text !== '￼' && last.text !== '￼') {
        list[list.length - 1] = { ...last, to: s.to, text: last.text + s.text };
      } else list.push(s);
      return list;
    }, []);
    for (const [from, to] of citationRanges(merged)) found.push(Decoration.inline(from, to, { class: 'citation' }));
    return false;
  });
  return DecorationSet.create(doc, found);
}

const key = new PluginKey<DecorationSet>('citations');

/**
 * Marks source citations with the class "citation", so the page can hide them with CSS
 * (`.hide-sources`). Decorations only: the document, and so the stored Markdown, is unchanged.
 */
export const Citations = Extension.create({
  name: 'citations',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_, { doc }) => decorations(doc),
          apply: (tr, set) => (tr.docChanged ? decorations(tr.doc) : set),
        },
        props: { decorations: (state) => key.getState(state) },
      }),
    ];
  },
});
