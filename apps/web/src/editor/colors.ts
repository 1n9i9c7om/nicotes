import { Mark } from '@tiptap/core';
import {
  DEFAULT_HIGHLIGHT,
  HIGHLIGHT_SOURCE,
  highlightMarkdown,
  isColor,
  MARK_SOURCE,
  SPAN_SOURCE,
  textColorMarkdown,
  type Color,
} from '@nicotes/shared';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    highlight: {
      setHighlight: (color?: Color) => ReturnType;
      toggleHighlight: () => ReturnType;
      unsetHighlight: () => ReturnType;
    };
    textColor: {
      setTextColor: (color: Color) => ReturnType;
      unsetTextColor: () => ReturnType;
    };
  }
}

const HIGHLIGHT_START = new RegExp(`^(?:${HIGHLIGHT_SOURCE})`);
const MARK_START = new RegExp(`^${MARK_SOURCE}`);
const SPAN_START = new RegExp(`^${SPAN_SOURCE}`);

/** Index of the first of `needles` in `src`, or -1 (marked's `start` contract). */
const firstIndex = (src: string, needles: string[]) => {
  const found = needles.map((n) => src.indexOf(n)).filter((i) => i >= 0);
  return found.length ? Math.min(...found) : -1;
};

const colorAttr = (fallback: Color | null) => ({
  color: {
    default: fallback,
    parseHTML: (el: HTMLElement) => (isColor(el.dataset.color) ? el.dataset.color : fallback),
    renderHTML: (attrs: { color?: string | null }) => (attrs.color ? { 'data-color': attrs.color } : {}),
  },
});

/** Background highlight: "==text==" or `<mark style="background: green">text</mark>`. */
export const Highlight = Mark.create({
  name: 'highlight',
  addAttributes: () => colorAttr(DEFAULT_HIGHLIGHT),
  parseHTML: () => [{ tag: 'mark' }],
  renderHTML: ({ mark, HTMLAttributes }) => ['mark', { ...HTMLAttributes, class: `hl-${mark.attrs.color as Color}` }, 0],

  markdownTokenizer: {
    name: 'highlight',
    level: 'inline',
    start: (src) => firstIndex(src, ['==', '<mark']),
    tokenize(src, _tokens, lexer) {
      const plain = HIGHLIGHT_START.exec(src);
      const tagged = plain ? null : MARK_START.exec(src);
      if (!plain && !tagged) return;
      const text = plain ? plain[1]! : tagged![2]!;
      return {
        type: 'highlight',
        raw: (plain ?? tagged)![0],
        text,
        color: plain ? DEFAULT_HIGHLIGHT : tagged![1],
        tokens: lexer.inlineTokens(text),
      };
    },
  },
  parseMarkdown: (token, helpers) =>
    helpers.applyMark('highlight', helpers.parseInline(token.tokens ?? []), { color: (token as { color?: Color }).color }),
  renderMarkdown: (node, helpers) => {
    const color = node.attrs?.color as Color | undefined;
    return highlightMarkdown(helpers.renderChildren(node), isColor(color) ? color : DEFAULT_HIGHLIGHT);
  },

  addCommands() {
    return {
      setHighlight:
        (color = DEFAULT_HIGHLIGHT) =>
        ({ commands }) =>
          commands.setMark(this.name, { color }),
      toggleHighlight:
        () =>
        ({ commands }) =>
          commands.toggleMark(this.name, { color: DEFAULT_HIGHLIGHT }),
      unsetHighlight:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
  addKeyboardShortcuts() {
    return { 'Mod-Shift-h': () => this.editor.commands.toggleHighlight() };
  },
});

/** Coloured text: `<span style="color: red">text</span>`. */
export const TextColor = Mark.create({
  name: 'textColor',
  addAttributes: () => colorAttr(null),
  parseHTML: () => [{ tag: 'span[data-color]' }],
  renderHTML: ({ mark, HTMLAttributes }) => ['span', { ...HTMLAttributes, class: `tc-${mark.attrs.color as Color}` }, 0],

  markdownTokenizer: {
    name: 'textColor',
    level: 'inline',
    start: (src) => src.indexOf('<span'),
    tokenize(src, _tokens, lexer) {
      const match = SPAN_START.exec(src);
      if (!match) return;
      return { type: 'textColor', raw: match[0], text: match[2]!, color: match[1], tokens: lexer.inlineTokens(match[2]!) };
    },
  },
  parseMarkdown: (token, helpers) =>
    helpers.applyMark('textColor', helpers.parseInline(token.tokens ?? []), { color: (token as { color?: Color }).color }),
  renderMarkdown: (node, helpers) => {
    const color = node.attrs?.color as Color | undefined;
    const text = helpers.renderChildren(node);
    return isColor(color) ? textColorMarkdown(text, color) : text;
  },

  addCommands() {
    return {
      setTextColor:
        (color) =>
        ({ commands }) =>
          commands.setMark(this.name, { color }),
      unsetTextColor:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
});
