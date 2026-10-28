import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { editorExtensions } from './extensions';

let editor: Editor | null = null;
afterEach(() => editor?.destroy());

/** The text the citation decorations cover, and the text left visible. */
function split(markdown: string) {
  editor = new Editor({ extensions: editorExtensions(), content: markdown, contentType: 'markdown' });
  const root = editor.view.dom;
  const hidden = [...root.querySelectorAll('.citation')].map((el) => el.textContent);
  const visible = [...root.querySelectorAll('p')]
    .map((el) => {
      const copy = el.cloneNode(true) as HTMLElement;
      copy.querySelectorAll('.citation').forEach((c) => c.remove());
      return copy.textContent;
    })
    .join('|');
  return { hidden, visible, markdown: editor.getMarkdown() };
}

describe('citation decorations', () => {
  it('cover numbered source links, their commas and the space before them', () => {
    const md = "It's gooey [2](https://a.example/2), [3](https://a.example/3), [7](https://a.example/7). It's simple.";
    const { hidden, visible, markdown } = split(md);
    expect(visible).toBe("It's gooey. It's simple.");
    expect(hidden.join('')).toBe(' 2, 3, 7');
    // Only decorations: the document is unchanged.
    expect(markdown).toBe(md);
  });

  it('leave ordinary links, numbers and wiki links alone', () => {
    const { visible } = split('See [the guide](https://a.example/g), bake 2 cakes and read [[Kladdkaka]] [1](https://a.example/1).');
    expect(visible).toBe('See the guide, bake 2 cakes and read Kladdkaka.');
  });

  it('also cover plain ranges and citations in list items and tables', () => {
    const { visible } = split(
      '- Butter melted [4](https://a.example/4).\n- No single setting \\[1–14\\].\n\n| Source | Temp |\n| --- | --- |\n| [2](https://a.example/2) TasteAtlas | 200°C |',
    );
    expect(visible).toBe('Butter melted.|No single setting.|Source|Temp|TasteAtlas|200°C');
  });
});
