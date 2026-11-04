import { Node } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { isCanvas, sectionOf, splitSection } from '@nicotes/shared';
import type { LinkBridge } from '../lib/links';

/** `![[Page]]`, `![[Page#Heading]]`, with an optional `|label`, on a line of its own. */
const EMBED = /^!\[\[([^[\]|\n]+?)(?:\|([^[\]\n]+?))?\]\][ \t]*(?:\n|$)/;

export interface EmbeddedPage {
  id: string;
  title: string;
  content: string;
}

export interface EmbedOptions {
  bridge: LinkBridge | null;
  /** Fetches the embedded page; without it, embeds show as links. */
  load: ((pageId: string) => Promise<EmbeddedPage | null>) | null;
  /** Shows Markdown read-only inside `element` (an editor of its own, one level deeper). */
  render: ((element: HTMLElement, markdown: string) => { destroy: () => void }) | null;
  /** Embeds inside embeds; from the second level on they show as links (no loops). */
  depth: number;
  /** A canvas page as a picture; null when nothing is drawn on it. */
  picture: ((content: string) => Promise<SVGSVGElement | null>) | null;
  /** Editing drawings in place; without it they are only shown. */
  drawings: Pick<DrawingEnv, 'open' | 'subscribe'> | null;
}

/** Drawings inside a page: canvas subpages shown by embeds, edited over the page. */
export interface DrawingEnv {
  /** Makes a new drawing; `target` is what to write between the brackets. */
  create: () => Promise<{ id: string; target: string }>;
  /** Opens a drawing to edit. */
  open: (pageId: string) => void;
  /** Tells when a drawing was edited. */
  subscribe: (listener: (pageId: string) => void) => () => void;
}

interface EmbedAttrs {
  target: string;
  label: string | null;
}

const markdownOf = ({ target, label }: EmbedAttrs) => `![[${target}${label ? `|${label}` : ''}]]`;

const key = new PluginKey('embeds');

/**
 * A page, or a section of one, shown inside another page (`![[Page#Heading]]`, as in
 * Obsidian). The embedded text is read-only here; the heading above it opens the page to edit
 * it. Typing `![[` and picking a page on a line of its own makes one. A canvas page shows as a
 * picture, which opens it for drawing.
 */
export const Embed = Node.create<EmbedOptions>({
  name: 'embed',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addOptions() {
    return { bridge: null, load: null, render: null, depth: 0, picture: null, drawings: null };
  },

  addAttributes() {
    return {
      target: { default: '', renderHTML: () => ({}) },
      label: { default: null, renderHTML: () => ({}) },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-embed]',
        getAttrs: (el) => ({ target: (el as HTMLElement).dataset.embed ?? '', label: (el as HTMLElement).dataset.label ?? null }),
      },
    ];
  },

  renderHTML({ node }) {
    const { target, label } = node.attrs as EmbedAttrs;
    return ['div', { class: 'embed', 'data-embed': target, ...(label ? { 'data-label': label } : {}) }, markdownOf(node.attrs as EmbedAttrs)];
  },

  renderText({ node }) {
    return markdownOf(node.attrs as EmbedAttrs);
  },

  addNodeView() {
    const { bridge, load, render, depth, picture, drawings } = this.options;
    return ({ node: initial }) => {
      let node: PMNode = initial;
      let shown = '';
      let inner: { destroy: () => void } | null = null;
      let alive = true;

      const dom = document.createElement('div');
      dom.className = 'embed';
      dom.contentEditable = 'false';
      const head = document.createElement('a');
      head.className = 'embed-head';
      head.href = '#';
      const body = document.createElement('div');
      body.className = 'embed-body';
      dom.append(head, body);
      head.addEventListener('click', (event) => {
        event.preventDefault();
        bridge?.open(splitSection((node.attrs as EmbedAttrs).target).page);
      });

      const message = (text: string) => {
        inner?.destroy();
        inner = null;
        body.replaceChildren(...(text ? [Object.assign(document.createElement('p'), { className: 'embed-note', textContent: text })] : []));
      };

      /** A canvas page: its picture, which opens it for drawing. Not a button: those aren't printed. */
      const showDrawing = (svg: SVGSVGElement | null, pageId: string) => {
        inner?.destroy();
        inner = null;
        const box = document.createElement('div');
        box.className = 'embed-drawing';
        if (svg) box.append(svg);
        else box.append(Object.assign(document.createElement('p'), { className: 'embed-note', textContent: drawings ? 'Nothing drawn yet: click to draw.' : 'Nothing drawn yet.' }));
        if (drawings) {
          box.tabIndex = 0;
          box.setAttribute('role', 'button');
          box.setAttribute('aria-label', 'Edit this drawing');
          box.addEventListener('click', () => drawings.open(pageId));
          box.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            drawings.open(pageId);
          });
        }
        body.replaceChildren(box);
      };

      const show = async () => {
        const { target, label } = node.attrs as EmbedAttrs;
        const { page, section } = splitSection(target);
        const resolved = bridge?.resolve(target) ?? null;
        head.textContent = label || (resolved ? `${resolved.path}${section ? ` › ${section}` : ''}` : target);
        dom.dataset.embed = target;
        dom.classList.toggle('unresolved', !resolved);
        const wanted = `${resolved?.id ?? ''}#${section ?? ''}`;
        if (wanted === shown) return;
        shown = wanted;
        if (!resolved) return message(bridge?.readOnly ? 'Not part of what was shared.' : `No page “${page}” yet.`);
        if (!load || !render || depth >= 2) return message('');
        const loaded = await load(resolved.id).catch(() => null);
        if (!alive || shown !== wanted) return;
        if (!loaded) return message('This page could not be loaded.');
        if (isCanvas(loaded.content)) {
          const svg = picture ? await picture(loaded.content).catch(() => null) : null;
          if (alive && shown === wanted) showDrawing(svg, resolved.id);
          return;
        }
        const text = section ? sectionOf(loaded.content, section) : loaded.content;
        if (text === null) return message(`“${loaded.title}” has no heading “${section}”.`);
        inner?.destroy();
        body.replaceChildren();
        inner = render(body, text);
      };
      void show();
      const unsubscribe = bridge?.subscribe(() => void show());
      // A drawing that was edited here shows again.
      const unsubscribeDrawings = drawings?.subscribe((pageId) => {
        if (!shown.startsWith(`${pageId}#`)) return;
        shown = '';
        void show();
      });

      return {
        dom,
        update: (next) => {
          if (next.type !== node.type) return false;
          node = next;
          void show();
          return true;
        },
        // The embedded editor handles its own clicks (links, checkboxes are read-only).
        stopEvent: (event) => body.contains(event.target as globalThis.Node),
        ignoreMutation: () => true,
        destroy: () => {
          alive = false;
          unsubscribe?.();
          unsubscribeDrawings?.();
          inner?.destroy();
        },
      };
    };
  },

  markdownTokenizer: {
    name: 'embed',
    level: 'block',
    start: (src) => (src.startsWith('![[') ? 0 : ((i) => (i < 0 ? -1 : i + 1))(src.indexOf('\n![['))),
    tokenize(src) {
      const match = EMBED.exec(src);
      if (!match) return undefined;
      return { type: 'embed', raw: match[0], target: match[1]!.trim(), label: match[2]?.trim() ?? null };
    },
  },

  parseMarkdown(token) {
    return { type: 'embed', attrs: { target: token.target, label: token.label } };
  },

  renderMarkdown(node) {
    return markdownOf(node.attrs as EmbedAttrs);
  },

  addProseMirrorPlugins() {
    const type = this.type;
    return [
      new Plugin({
        key,
        // "!" and a [[link]] just picked: alone in a paragraph an embed, within text `![[…]]`.
        appendTransaction(transactions, _old, state) {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          const { $from } = state.selection;
          // Picking a link from the list also adds a space after it.
          const space = $from.nodeBefore?.isText && $from.nodeBefore.text === ' ' ? 1 : 0;
          const link = state.doc.resolve($from.pos - space).nodeBefore;
          if (!link || link.type.name !== 'wikilink' || link.attrs.embed) return null;
          const linkStart = $from.pos - space - link.nodeSize;
          const bang = state.doc.resolve(linkStart).nodeBefore;
          if (!bang?.isText || !bang.text!.endsWith('!')) return null;
          const paragraph = $from.parent;
          // Alone: "!", the link and at most the picker's space (text after it joins that node).
          const alone = paragraph.childCount === 2 + space && bang.text === '!' && (!space || paragraph.lastChild!.text === ' ');
          if (paragraph.type.name === 'paragraph' && alone) {
            const from = $from.before();
            return state.tr.replaceWith(from, from + paragraph.nodeSize, type.create({ target: link.attrs.target, label: link.attrs.label }));
          }
          return state.tr.delete(linkStart - 1, linkStart).setNodeMarkup(linkStart - 1, undefined, { ...link.attrs, embed: true });
        },
      }),
    ];
  },
});
