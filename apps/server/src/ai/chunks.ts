/**
 * Splits a page into passages for the semantic index: by heading, then by paragraph, each at
 * most about MAX_CHARS long. Markdown syntax that carries no meaning (URLs, image links) is
 * dropped; wikilinks keep their visible text.
 */

import { withoutColors } from '@nicotes/shared';

export interface Chunk {
  ord: number;
  /** Heading path above the passage, e.g. "Builds › Strength". */
  heading: string;
  text: string;
}

const MAX_CHARS = 1200;
const MIN_CHARS = 200;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Markdown reduced to the text a reader sees. */
export function plainText(markdown: string): string {
  return withoutColors(markdown)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/<[^>\n]+>/g, ' ')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^(\s*)[-*+] \[[ xX]\] /gm, '$1- ')
    .replace(/\*\*|__|~~|`/g, '')
    .replace(/[ \t]+/g, ' ');
}

function splitLong(paragraph: string): string[] {
  if (paragraph.length <= MAX_CHARS) return [paragraph];
  const parts: string[] = [];
  let current = '';
  for (const sentence of paragraph.split(/(?<=[.!?])\s+|\n/)) {
    if (current && current.length + sentence.length + 1 > MAX_CHARS) {
      parts.push(current);
      current = '';
    }
    // A single sentence longer than the limit is cut hard.
    for (let s = sentence; s.length; s = s.slice(MAX_CHARS)) {
      const piece = s.slice(0, MAX_CHARS);
      if (current && current.length + piece.length + 1 > MAX_CHARS) {
        parts.push(current);
        current = '';
      }
      current = current ? `${current} ${piece}` : piece;
    }
  }
  if (current) parts.push(current);
  return parts;
}

export function chunkPage(markdown: string): Chunk[] {
  const sections: { heading: string; paragraphs: string[] }[] = [];
  const path: string[] = [];
  let section = { heading: '', paragraphs: [] as string[] };
  let paragraph: string[] = [];
  let fence: string | null = null;
  const endParagraph = () => {
    const text = plainText(paragraph.join('\n')).trim();
    if (text) section.paragraphs.push(text);
    paragraph = [];
  };

  for (const line of markdown.split('\n')) {
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      else paragraph.push(line);
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      endParagraph();
      sections.push(section);
      path.length = Math.min(path.length, h[1]!.length - 1);
      path[h[1]!.length - 1] = plainText(h[2]!).trim();
      section = { heading: path.filter(Boolean).join(' › '), paragraphs: [] };
      continue;
    }
    if (!line.trim()) endParagraph();
    else paragraph.push(line);
  }
  endParagraph();
  sections.push(section);

  const chunks: Chunk[] = [];
  for (const s of sections) {
    let current = '';
    const flush = () => {
      if (current) chunks.push({ ord: chunks.length, heading: s.heading, text: current });
      current = '';
    };
    for (const p of s.paragraphs.flatMap(splitLong)) {
      if (current && current.length + p.length + 2 > MAX_CHARS) flush();
      current = current ? `${current}\n\n${p}` : p;
      if (current.length >= MAX_CHARS - MIN_CHARS) flush();
    }
    flush();
  }
  return chunks;
}

/** What is actually embedded: the passage with its page title and heading as context. */
export const embeddingInput = (title: string, chunk: Pick<Chunk, 'heading' | 'text'>) =>
  `${title.trim() || 'Untitled'}${chunk.heading ? ` › ${chunk.heading}` : ''}\n\n${chunk.text}`.trim();
