/**
 * Text colours and highlights, stored the way Obsidian (and its Highlightr plugin) writes them:
 * "==text==" for the default highlight, `<mark style="background: green">text</mark>` for other
 * highlights and `<span style="color: red">text</span>` for coloured text. Only the palette's
 * names are recognised (the app shows them in tones that suit the theme); any other HTML stays
 * plain text.
 */

export const COLORS = ['yellow', 'orange', 'red', 'purple', 'blue', 'green'] as const;
export type Color = (typeof COLORS)[number];

/** The colour of "==text==". */
export const DEFAULT_HIGHLIGHT: Color = 'yellow';

export const COLOR_LABELS: Record<Color, string> = {
  yellow: 'Yellow',
  orange: 'Orange',
  red: 'Red',
  purple: 'Purple',
  blue: 'Blue',
  green: 'Green',
};

export const isColor = (value: unknown): value is Color => COLORS.includes(value as Color);

const NAMES = COLORS.join('|');

/** "==text==": no spaces just inside the markers, one line. Group 1 is the text. */
export const HIGHLIGHT_SOURCE = '==(?![\\s=])(.+?)(?<![\\s=])==';
/** Group 1 is the colour, group 2 the text. */
export const MARK_SOURCE = `<mark style="background: ?(${NAMES});?">(.+?)</mark>`;
/** Group 1 is the colour, group 2 the text. */
export const SPAN_SOURCE = `<span style="color: ?(${NAMES});?">(.+?)</span>`;

export const highlightMarkdown = (text: string, color: Color) =>
  color === DEFAULT_HIGHLIGHT ? `==${text}==` : `<mark style="background: ${color}">${text}</mark>`;

export const textColorMarkdown = (text: string, color: Color) => `<span style="color: ${color}">${text}</span>`;

/** Text without colour markup, for plain-text uses (excerpts, read-aloud, AI input). */
export function withoutColors(text: string): string {
  let out = text;
  // Highlights and coloured text may nest, so strip until nothing changes.
  for (let previous = ''; previous !== out; ) {
    previous = out;
    out = out
      .replace(new RegExp(MARK_SOURCE, 'g'), '$2')
      .replace(new RegExp(SPAN_SOURCE, 'g'), '$2')
      .replace(new RegExp(HIGHLIGHT_SOURCE, 'g'), '$1');
  }
  return out;
}
