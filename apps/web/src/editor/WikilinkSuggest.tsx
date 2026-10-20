import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { Extension } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import { ReactRenderer } from '@tiptap/react';
import Suggestion, { type SuggestionProps } from '@tiptap/suggestion';
import { FilePlus, FileText } from 'lucide-react';
import type { LinkBridge, LinkSuggestion } from '../lib/links';

interface ListHandle {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

type ListProps = SuggestionProps<LinkSuggestion, LinkSuggestion>;

export const SuggestionList = forwardRef<ListHandle, { items: LinkSuggestion[]; command: (item: LinkSuggestion) => void }>(
  function SuggestionList({ items, command }, ref) {
    const [selected, setSelected] = useState(0);
    useEffect(() => setSelected(0), [items]);

    useImperativeHandle(ref, () => ({
      onKeyDown: (event) => {
        if (!items.length) return false;
        if (event.key === 'ArrowDown') {
          setSelected((i) => (i + 1) % items.length);
          return true;
        }
        if (event.key === 'ArrowUp') {
          setSelected((i) => (i - 1 + items.length) % items.length);
          return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          command(items[selected]!);
          return true;
        }
        return false;
      },
    }));

    if (!items.length) return <div className="suggest empty">Type to search pages…</div>;
    return (
      <div className="suggest" role="listbox">
        {items.map((item, i) => (
          <button
            key={item.id ?? `new:${item.title}`}
            role="option"
            aria-selected={i === selected}
            className={i === selected ? 'suggest-item active' : 'suggest-item'}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setSelected(i)}
            onClick={() => command(item)}
          >
            {item.id ? <FileText size={15} /> : <FilePlus size={15} />}
            <span className="suggest-title">{item.title}</span>
            <span className="suggest-where">{item.where}</span>
          </button>
        ))}
      </div>
    );
  },
);

/** Places a fixed popup under the caret, flipping above it near the bottom of the screen. */
export function placePopup(el: HTMLElement, rect: DOMRect | null | undefined) {
  if (!rect) return;
  const width = Math.min(360, window.innerWidth - 16);
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  const below = rect.bottom + 6;
  const height = el.offsetHeight || 240;
  const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 6) : below;
  Object.assign(el.style, { position: 'fixed', left: `${left}px`, top: `${top}px`, width: `${width}px`, zIndex: '60' });
}

/** `[[` autocomplete in the visual editor. */
export const WikilinkSuggest = Extension.create<{ bridge: LinkBridge | null }>({
  name: 'wikilinkSuggest',

  addOptions() {
    return { bridge: null };
  },

  addProseMirrorPlugins() {
    const bridge = this.options.bridge;
    if (!bridge) return [];
    return [
      Suggestion<LinkSuggestion, LinkSuggestion>({
        editor: this.editor,
        pluginKey: new PluginKey('wikilinkSuggest'),
        char: '[[',
        allowSpaces: true,
        allowedPrefixes: null,
        items: ({ query }) => bridge.suggest(query.replace(/\]+$/, '')),
        command: ({ editor, range, props }) => {
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContent([{ type: 'wikilink', attrs: { target: props.target, label: null } }, { type: 'text', text: ' ' }])
            .run();
        },
        render: () => {
          let renderer: ReactRenderer<ListHandle, { items: LinkSuggestion[]; command: (i: LinkSuggestion) => void }> | null =
            null;
          const update = (props: ListProps) => {
            renderer?.updateProps({ items: props.items, command: props.command });
            requestAnimationFrame(() => renderer && placePopup(renderer.element as HTMLElement, props.clientRect?.()));
          };
          return {
            onStart: (props) => {
              renderer = new ReactRenderer(SuggestionList, {
                editor: props.editor,
                props: { items: props.items, command: props.command },
              });
              document.body.appendChild(renderer.element);
              placePopup(renderer.element as HTMLElement, props.clientRect?.());
              update(props);
            },
            onUpdate: update,
            onKeyDown: ({ event }) => {
              if (event.key === 'Escape') {
                renderer?.destroy();
                renderer?.element.remove();
                renderer = null;
                return true;
              }
              return renderer?.ref?.onKeyDown(event) ?? false;
            },
            onExit: () => {
              renderer?.destroy();
              renderer?.element.remove();
              renderer = null;
            },
          };
        },
      }),
    ];
  },
});
