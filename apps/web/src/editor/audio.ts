import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/** Links to audio attachments (also through a shared link): voice notes and other recordings. */
const AUDIO = /\/attachments\/[\w-]+\/[^?#]*\.(webm|weba|ogg|oga|opus|m4a|mp3|wav|aac)$/i;
export const isAudioUrl = (href: string) => AUDIO.test(href);

function player(src: string): HTMLElement {
  const audio = document.createElement('audio');
  audio.controls = true;
  audio.preload = 'metadata';
  audio.src = src;
  audio.className = 'voice-player';
  // Browsers record WebM without a length; seeking to the end once makes them work it out.
  audio.addEventListener('loadedmetadata', () => {
    if (audio.duration !== Infinity) return;
    audio.addEventListener('durationchange', () => (audio.currentTime = 0), { once: true });
    audio.currentTime = 1e101;
  });
  return audio;
}

/** A player after each link to an audio file (once, where a link is split by formatting). */
function players(doc: PMNode): DecorationSet {
  const widgets: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const href = node.marks.find((m) => m.type.name === 'link')?.attrs.href as string | undefined;
    if (!href || !isAudioUrl(href)) return;
    const end = pos + node.nodeSize;
    const next = doc.resolve(end).nodeAfter;
    if (next?.isText && next.marks.some((m) => m.type.name === 'link' && m.attrs.href === href)) return;
    // Keyed by address, so typing elsewhere keeps the element (and a playing recording).
    widgets.push(Decoration.widget(end, () => player(href), { key: `audio:${href}`, side: 1, ignoreSelection: true, stopEvent: () => true }));
  });
  return DecorationSet.create(doc, widgets);
}

/** Markdown keeps a voice note as a plain link; the editor shows a player next to it. */
export const AudioPlayers = Extension.create({
  name: 'audioPlayers',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('audioPlayers'),
        state: {
          init: (_, { doc }) => players(doc),
          apply: (tr, old) => (tr.docChanged ? players(tr.doc) : old),
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
        },
      }),
    ];
  },
});
