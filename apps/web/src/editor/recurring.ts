import { Extension } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { ReplaceStep } from '@tiptap/pm/transform';
import { moveDates, recurrenceOf } from '@nicotes/shared';
import { localDate } from '../lib/daily';

interface Item {
  pos: number;
  node: PmNode;
  checked: boolean;
  text: string;
}

function taskItems(doc: PmNode): Item[] {
  const items: Item[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'taskItem') items.push({ pos, node, checked: Boolean(node.attrs.checked), text: node.firstChild?.textContent ?? '' });
  });
  return items;
}

const key = new PluginKey('recurringTasks');

/**
 * Ticking off a recurring task (`🔁 every week`) in the editor adds its next occurrence above
 * it, as the task list, the views and Telegram do. One undo takes back both.
 */
export const RecurringTasks = Extension.create({
  name: 'recurringTasks',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key,
        appendTransaction(transactions, oldState, newState) {
          // Typing only replaces text; a tick changes a node's attributes.
          const ticks = transactions.some((tr) => tr.docChanged && tr.steps.some((s) => !(s instanceof ReplaceStep)));
          if (!ticks || transactions.some((tr) => tr.getMeta(key))) return null;
          const before = taskItems(oldState.doc);
          const after = taskItems(newState.doc);
          if (before.length !== after.length) return null;
          const ticked = after.filter((item, i) => item.checked && !before[i]!.checked && item.text === before[i]!.text && item.text.includes('🔁'));
          if (ticked.length !== 1) return null;
          const item = ticked[0]!;
          const recurrence = recurrenceOf(item.text, localDate());
          const paragraph = item.node.firstChild;
          if (!recurrence || !paragraph) return null;

          const schema = newState.schema;
          const content: PmNode[] = [];
          paragraph.forEach((child) => content.push(child.isText ? schema.text(moveDates(child.text!, recurrence), child.marks) : child));
          if (!recurrence.due) content.push(schema.text(` 📅 ${recurrence.next}`));
          const next = item.node.type.create({ ...item.node.attrs, checked: false }, paragraph.type.create(paragraph.attrs, content));
          return newState.tr.insert(item.pos, next).setMeta(key, true);
        },
      }),
    ];
  },
});
