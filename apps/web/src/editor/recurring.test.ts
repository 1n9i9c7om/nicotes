import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { editorExtensions } from './extensions';

function tick(editor: Editor, index: number) {
  let found = -1;
  let seen = 0;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'taskItem' && seen++ === index) found = pos;
  });
  const node = editor.state.doc.nodeAt(found)!;
  editor.view.dispatch(editor.state.tr.setNodeMarkup(found, undefined, { ...node.attrs, checked: true }));
}

describe('recurring tasks in the editor', () => {
  afterEach(() => vi.useRealTimers());

  it('adds the next occurrence when one is ticked off, and undoes both at once', () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 4, 10) });
    const editor = new Editor({
      extensions: editorExtensions(),
      content: '- [ ] Water **plants** 🔁 every week 📅 2026-11-02\n- [ ] Call mom',
      contentType: 'markdown',
    });
    tick(editor, 0);
    expect(editor.getMarkdown().trim()).toBe(
      '- [ ] Water **plants** 🔁 every week 📅 2026-11-09\n- [x] Water **plants** 🔁 every week 📅 2026-11-02\n- [ ] Call mom',
    );
    editor.commands.undo();
    expect(editor.getMarkdown().trim()).toBe('- [ ] Water **plants** 🔁 every week 📅 2026-11-02\n- [ ] Call mom');
    // Other tasks tick off as before.
    tick(editor, 1);
    expect(editor.getMarkdown().trim()).toBe('- [ ] Water **plants** 🔁 every week 📅 2026-11-02\n- [x] Call mom');
    editor.destroy();
  });
});
