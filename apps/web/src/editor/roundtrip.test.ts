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
};

describe('markdown round-trip', () => {
  for (const [name, md] of Object.entries(samples)) {
    it(name, () => {
      expect(roundtrip(md).trim()).toBe(md);
    });
  }
});
