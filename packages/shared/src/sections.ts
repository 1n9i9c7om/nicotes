/** Small edits of Markdown sections, used when Nicotes adds a task or a link to a page. */

const ANY_HEADING = /^ {0,3}#{1,6}\s/;
const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s/;

/**
 * Inserts a list item after the last list item of the first section whose heading matches
 * `heading` (or right below the heading). Returns null if there is no such section.
 */
export function addToSection(markdown: string, heading: RegExp, item: string): string | null {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && ANY_HEADING.test(l));
  if (end < 0) end = lines.length;
  let at = -1;
  for (let i = start + 1; i < end; i++) if (LIST_ITEM.test(lines[i]!)) at = i + 1;
  if (at < 0) lines.splice(start + 1, 0, '', item);
  else lines.splice(at, 0, item);
  return lines.join('\n');
}

/** Appends a block at the end of the page, keeping lists together. */
export function appendBlock(markdown: string, block: string, joinList = false): string {
  const trimmed = markdown.replace(/\s+$/, '');
  if (!trimmed) return block;
  return `${trimmed}${joinList ? '\n' : '\n\n'}${block}`;
}

const SEE_ALSO = /^ {0,3}#{1,6}\s+(see also|related|siehe auch|verwandt)\s*#*\s*$/i;

/** Adds `[[target]]` to the page's "See also" section, creating it at the end if needed. */
export function appendSeeAlso(markdown: string, target: string): string {
  const item = `- [[${target}]]`;
  return addToSection(markdown, SEE_ALSO, item) ?? appendBlock(markdown, `## See also\n\n${item}`);
}
