/** Block structure of the Markdown subset AI answers use (rendered by components/Markdown). */

export type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'list'; ordered: boolean; items: { depth: number; text: string }[] };

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

export function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      const code: string[] = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i]!)) code.push(lines[i]!);
      blocks.push({ kind: 'code', text: code.join('\n') });
      continue;
    }
    if (!line.trim()) continue;
    const heading = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]! });
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      const ordered = /\d/.test(item[2]!);
      const last = blocks.at(-1);
      const entry = { depth: Math.floor(item[1]!.replace(/\t/g, '  ').length / 2), text: item[3]! };
      if (last?.kind === 'list' && (last.ordered === ordered || entry.depth > 0)) last.items.push(entry);
      else blocks.push({ kind: 'list', ordered, items: [entry] });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const last = blocks.at(-1);
      const text = line.replace(/^\s*>\s?/, '');
      if (last?.kind === 'quote') last.text += ` ${text}`;
      else blocks.push({ kind: 'quote', text });
      continue;
    }
    const last = blocks.at(-1);
    // Lazy continuation: a line right after a paragraph or list item belongs to it.
    const previous = lines[i - 1] ?? '';
    if (previous.trim() && last?.kind === 'paragraph') last.text += ` ${line.trim()}`;
    else if (previous.trim() && last?.kind === 'list') last.items.at(-1)!.text += ` ${line.trim()}`;
    else blocks.push({ kind: 'paragraph', text: line.trim() });
  }
  return blocks;
}
