import { InputRule, Node, mergeAttributes, nodePasteRule } from '@tiptap/core';

const WIKILINK = /^\[\[([^[\]|\n]+?)(?:\|([^[\]\n]+?))?\]\]/;
const WIKILINK_INPUT = /\[\[([^[\]|\n]+?)(?:\|([^[\]\n]+?))?\]\]$/;

export interface WikilinkAttrs {
  /** Target page title (optionally `Notebook/Title`). */
  target: string;
  /** Display text from `[[target|label]]`. */
  label: string | null;
}

/**
 * Inline `[[wikilink]]` node. Kept atomic so the Markdown serializer writes it back verbatim
 * instead of escaping the brackets. Resolution to page ids happens server-side (phase 2).
 */
export const Wikilink = Node.create({
  name: 'wikilink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    // Rendered explicitly in renderHTML as data attributes.
    return {
      target: { default: '', renderHTML: () => ({}) },
      label: { default: null, renderHTML: () => ({}) },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-wikilink]',
        getAttrs: (el) => ({
          target: (el as HTMLElement).dataset.wikilink ?? '',
          label: (el as HTMLElement).dataset.label ?? null,
        }),
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const { target, label } = node.attrs as WikilinkAttrs;
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        class: 'wikilink',
        'data-wikilink': target,
        ...(label ? { 'data-label': label } : {}),
      }),
      label || target,
    ];
  },

  renderText({ node }) {
    const { target, label } = node.attrs as WikilinkAttrs;
    return label || target;
  },

  addInputRules() {
    return [
      new InputRule({
        find: WIKILINK_INPUT,
        handler: ({ state, range, match }) => {
          const target = match[1]?.trim();
          if (!target) return;
          state.tr.replaceWith(
            range.from,
            range.to,
            this.type.create({ target, label: match[2]?.trim() || null }),
          );
        },
      }),
    ];
  },

  addPasteRules() {
    return [
      nodePasteRule({
        find: new RegExp(WIKILINK_INPUT.source.replace(/\$$/, ''), 'g'),
        type: this.type,
        getAttributes: (match) => ({ target: match[1]?.trim() ?? '', label: match[2]?.trim() || null }),
      }),
    ];
  },

  markdownTokenizer: {
    name: 'wikilink',
    level: 'inline',
    start: (src) => src.indexOf('[['),
    tokenize(src) {
      const match = WIKILINK.exec(src);
      if (!match) return undefined;
      return { type: 'wikilink', raw: match[0], target: match[1]!.trim(), label: match[2]?.trim() ?? null };
    },
  },

  parseMarkdown(token) {
    return { type: 'wikilink', attrs: { target: token.target, label: token.label } };
  },

  renderMarkdown(node) {
    const { target, label } = node.attrs as WikilinkAttrs;
    return `[[${target}${label ? `|${label}` : ''}]]`;
  },
});
