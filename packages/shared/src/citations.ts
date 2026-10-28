/**
 * Source citations as Research writes them ("… gooey [2](https://…), [3](https://…).") and as
 * plain numbers ("[1–14]"). Views can hide them; the page text keeps them.
 */

/** Whether a page has citations worth hiding. */
export const hasCitations = (markdown: string) =>
  /\[\d{1,3}(?:\s*[,–-]\s*\d{1,3})*\]\(https?:\/\/[^)\s]+\)|\\?\[\d{1,3}\s*[–-]\s*\d{1,3}\\?\](?!\()/.test(markdown);

/**
 * Text without citations ("[3](https://…)", "[1–14]") and escaped tildes, for views that hide
 * sources. Ordinary links with words as their text stay.
 */
export function withoutCitations(text: string): string {
  return text
    .replace(/(?:\s*,?\s*\[\d+(?:\s*[,–-]\s*\d+)*\]\(https?:\/\/[^)\s]+\))+/g, '')
    .replace(/\s*\\?\[\d+(?:\s*[,–-]\s*\d+)*\\?\](?!\()/g, '')
    .replace(/\\~/g, '~')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
}

