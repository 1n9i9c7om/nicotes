import { Editor } from '@tiptap/core';
import { describe, expect, it } from 'vitest';
import { editorExtensions } from './extensions';

const editorFor = (markdown: string) => new Editor({ extensions: editorExtensions(), content: markdown, contentType: 'markdown' });

describe('embeds in the editor', () => {
  it('reads and writes embeds on lines of their own, and leaves other text alone', () => {
    const md = 'Intro\n\n![[Bread#Steps|Steps]]\n\n![[Notes]]\n\nNot an embed: ![[Inline]] here.';
    const editor = editorFor(md);
    const kinds: string[] = [];
    editor.state.doc.forEach((node) => kinds.push(node.type.name));
    expect(kinds).toEqual(['paragraph', 'embed', 'embed', 'paragraph']);
    expect(editor.getMarkdown().trim()).toBe(md);
    editor.destroy();
  });

  it('turns "!" and a picked link alone in a paragraph into an embed', () => {
    const editor = editorFor('Intro');
    editor.commands.focus('end');
    editor.commands.insertContent([
      { type: 'paragraph', content: [{ type: 'text', text: '!' }] },
    ]);
    editor.commands.insertContent({ type: 'wikilink', attrs: { target: 'Bread', label: null } });
    expect(editor.getMarkdown().trim()).toBe('Intro\n\n![[Bread]]');
    editor.destroy();
  });
});

describe('inline embeds', () => {
  it('keeps ![[link]] within text as written, also when typed', () => {
    const editor = editorFor('See ![[Bread]] now');
    expect(editor.getMarkdown().trim()).toBe('See ![[Bread]] now');
    editor.commands.setContent('Try ', { contentType: 'markdown' });
    editor.commands.focus('end');
    editor.commands.insertContent('!');
    editor.commands.insertContent({ type: 'wikilink', attrs: { target: 'Rye', label: null } });
    expect(editor.getMarkdown().trim()).toBe('Try ![[Rye]]');
    editor.destroy();
  });

  it('keeps the rest of the line when a link is picked after "!" at its start', () => {
    const editor = editorFor('Intro');
    editor.commands.focus('start');
    editor.commands.insertContent('!');
    // As picked from the list: the link and a space, which joins the text after it.
    editor.commands.insertContent([{ type: 'wikilink', attrs: { target: 'Bread', label: null } }, { type: 'text', text: ' ' }]);
    expect(editor.getMarkdown().trim()).toBe('![[Bread]] Intro');
    editor.destroy();
  });
});
