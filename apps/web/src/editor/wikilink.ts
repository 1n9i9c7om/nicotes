import { InputRule, Node, mergeAttributes, nodePasteRule, type JSONContent } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { MarkdownManager } from '@tiptap/markdown';
import type { LinkBridge } from '../lib/links';

const WIKILINK = /^\[\[([^[\]|\n]+?)(?:\|([^[\]\n]+?))?\]\]/;
const WIKILINK_INPUT = /\[\[([^[\]|\n]+?)(?:\|([^[\]\n]+?))?\]\]$/;

const wikilinkMarkdown = ({ target, label }: WikilinkAttrs) => `[[${target}${label ? `|${label}` : ''}]]`;

/**
 * @tiptap/markdown only formats text: bold or a highlight around a `[[wikilink]]` would be
 * dropped when a page loads ("**[[Elden Ring]]**" → "[[Elden Ring]]") and the next save would
 * lose it. Two private methods are extended for wikilinks: parsing also gives them the marks
 * around them, and saving writes a formatted wikilink as if it were text, so the formatting
 * spans it ("**a [[b]] c**"); the placeholder text is replaced by the link afterwards.
 */
function keepWikilinkFormatting() {
  type Manager = {
    applyMarkToContent(type: string, content: JSONContent[], attrs?: Record<string, unknown>): JSONContent[];
    renderNodesWithMarkBoundaries(nodes: JSONContent[], parent: unknown, separator?: string, level?: number): string;
  };
  const proto = MarkdownManager.prototype as unknown as Manager;
  const applyMark = proto.applyMarkToContent;
  proto.applyMarkToContent = function (type, content, attrs) {
    const mark = attrs ? { type, attrs } : { type };
    return applyMark.call(
      this,
      type,
      content.map((node) => (node.type === 'wikilink' ? { ...node, marks: [...(node.marks ?? []), mark] } : node)),
      attrs,
    );
  };

  const renderNodes = proto.renderNodesWithMarkBoundaries;
  proto.renderNodesWithMarkBoundaries = function (nodes, parent, separator, level) {
    const links: string[] = [];
    const swapped = nodes.map((node) => {
      if (node.type !== 'wikilink' || !node.marks?.length) return node;
      links.push(wikilinkMarkdown(node.attrs as WikilinkAttrs));
      return { type: 'text', text: `${links.length - 1}`, marks: node.marks };
    });
    const out = renderNodes.call(this, swapped, parent, separator, level);
    return links.length ? out.replace(/(\d+)/g, (_m, i: string) => links[Number(i)]!) : out;
  };
}
keepWikilinkFormatting();

export interface WikilinkAttrs {
  /** Target page title (optionally `Notebook/Title`). */
  target: string;
  /** Display text from `[[target|label]]`. */
  label: string | null;
}

export interface WikilinkOptions {
  /** Resolves and opens links; absent in tests, where links just render. */
  bridge: LinkBridge | null;
}

/**
 * Inline `[[wikilink]]` node. Kept atomic so the Markdown serializer writes it back verbatim
 * instead of escaping the brackets. Clicking opens the target (or creates it).
 */
export const Wikilink = Node.create<WikilinkOptions>({
  name: 'wikilink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addOptions() {
    return { bridge: null };
  },

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

  addNodeView() {
    const bridge = this.options.bridge;
    return ({ node: initial }) => {
      let node: PMNode = initial;
      const dom = document.createElement('span');
      dom.contentEditable = 'false';
      const render = () => {
        const { target, label } = node.attrs as WikilinkAttrs;
        const resolved = bridge?.resolve(target) ?? null;
        dom.className = resolved || !bridge ? 'wikilink' : 'wikilink unresolved';
        dom.dataset.wikilink = target;
        dom.textContent = label || target;
        dom.title = resolved ? resolved.path : bridge ? `Create page “${target}”` : target;
      };
      render();
      const unsubscribe = bridge?.subscribe(render);
      dom.addEventListener('click', (event) => {
        if (!bridge) return;
        event.preventDefault();
        bridge.open((node.attrs as WikilinkAttrs).target);
      });
      return {
        dom,
        update: (next) => {
          if (next.type !== node.type) return false;
          node = next;
          render();
          return true;
        },
        destroy: () => unsubscribe?.(),
      };
    };
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
    return wikilinkMarkdown(node.attrs as WikilinkAttrs);
  },
});
