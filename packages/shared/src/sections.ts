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

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING_LINE = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;

/**
 * The part of a page under a heading (`![[Page#Heading]]`), heading included, up to the next
 * heading of the same or a higher level. Headings match ignoring case, formatting and spaces;
 * null when there is no such heading.
 */
export function sectionOf(markdown: string, heading: string): string | null {
  const plain = (text: string) => text.replace(/[*_`~=]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const wanted = plain(heading);
  const lines = markdown.split('\n');
  let fence: string | null = null;
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const marker = FENCE_LINE.exec(lines[i]!)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    const h = HEADING_LINE.exec(lines[i]!);
    if (!h) continue;
    if (start >= 0 && h[1]!.length <= level) return lines.slice(start, i).join('\n').trim();
    if (start < 0 && plain(h[2]!) === wanted) {
      start = i;
      level = h[1]!.length;
    }
  }
  return start >= 0 ? lines.slice(start).join('\n').trim() : null;
}
