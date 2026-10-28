import { Editor } from '@tiptap/core';
import { describe, expect, it } from 'vitest';
import { editorExtensions } from './extensions';

function roundtrip(markdown: string): string {
  const editor = new Editor({ extensions: editorExtensions(), content: markdown, contentType: 'markdown' });
  const out = editor.getMarkdown();
  editor.destroy();
  return out;
}

const samples: Record<string, string> = {
  headings: '# Title\n\n## Section\n\nSome text.',
  emphasis: 'Some **bold**, *italic*, ~~struck~~ and `code`.',
  bullets: '- one\n- two\n  - nested\n- three',
  ordered: '1. first\n2. second\n3. third',
  tasks: '- [ ] open\n- [x] done',
  link: 'See [Nicotes](https://example.com) here.',
  code: '```ts\nconst a = 1;\n```',
  quote: '> quoted text',
  rule: 'above\n\n---\n\nbelow',
  // Tables are normalised to padded columns; the padded form must be stable.
  table: '| Item | Qty |\n| ---- | --- |\n| Egg  | 2   |',
  wikilink: 'Links to [[Elden Ring]] and [[Games/Builds|builds]].',
  image: '![map shot](/api/attachments/abc/map%20shot.png)',
  highlight: 'Some ==highlighted== text.',
  coloredHighlight: 'Some <mark style="background: green">green</mark> text.',
  textColor: 'Some <span style="color: red">red</span> text.',
  colorsWithEmphasis: 'A <span style="color: blue">**bold** blue</span> and [==a link==](https://example.com).',
  boldWikilink: 'See **[[Elden Ring]]** now.',
  formattedAroundWikilink: '**before [[Games/Builds|builds]] after** and ==[[Elden Ring]]==.',
  coloredWikilink: '<span style="color: red">[[Elden Ring]]</span> and *[[Factorio]] notes*',
  nestedColors:'<mark style="background: purple"><span style="color: yellow">both</span></mark> here.',
};

describe('markdown round-trip', () => {
  for (const [name, md] of Object.entries(samples)) {
    it(name, () => {
      expect(roundtrip(md).trim()).toBe(md);
    });
  }
});

describe('colours', () => {
  const marks = (markdown: string) => {
    const editor = new Editor({ extensions: editorExtensions(), content: markdown, contentType: 'markdown' });
    const json = JSON.stringify(editor.getJSON());
    editor.destroy();
    return json;
  };

  it('parses palette colours into marks', () => {
    expect(marks('==a==')).toContain('{"type":"highlight","attrs":{"color":"yellow"}}');
    expect(marks('<mark style="background: blue">a</mark>')).toContain('{"type":"highlight","attrs":{"color":"blue"}}');
    expect(marks('<span style="color: green;">a</span>')).toContain('{"type":"textColor","attrs":{"color":"green"}}');
  });

  it('leaves other HTML and spaced equals signs alone', () => {
    expect(marks('<span style="color: #ff0000">a</span>')).not.toContain('textColor');
    expect(marks('x == y == z')).not.toContain('highlight');
    expect(marks('`==code==`')).not.toContain('highlight');
  });

  it('saves a yellow highlight in the short form', () => {
    expect(roundtrip('<mark style="background: yellow">a</mark>').trim()).toBe('==a==');
  });
});
