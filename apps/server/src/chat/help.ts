import { readFileSync } from 'node:fs';
import { config } from '../config.js';

/**
 * The user guide (README.md) for the chat's nicotes_help tool, split into its sections so a
 * question gets the few that are about it. The Docker image carries the README next to the
 * app for this.
 */

interface Section {
  /** "Features › Tasks and connections". */
  title: string;
  text: string;
}

/** Characters of sections one answer returns at most. */
const MAX_CHARS = 9000;

const STOPWORDS = new Set(
  'the and for with how can what where does do is are was you your use using get set into from that this there not when which why'.split(' '),
);

let cached: Section[] | null = null;

export function guideSections(file = config.guideFile): Section[] {
  if (cached && file === config.guideFile) return cached;
  let markdown: string;
  try {
    markdown = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const sections: Section[] = [];
  let top = '';
  let current: Section | null = null;
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const heading = /^(##|###) (.+)$/.exec(line);
    if (heading) {
      const name = heading[2]!.trim();
      if (heading[1] === '##') top = name;
      current = { title: heading[1] === '##' ? name : `${top} › ${name}`, text: '' };
      sections.push(current);
      continue;
    }
    // Badges and images say nothing to the model.
    if (!current || /^\s*(\[!\[|!\[|<)/.test(line)) continue;
    current.text += `${line}\n`;
  }
  const result = sections.map((s) => ({ ...s, text: s.text.trim() })).filter((s) => s.text);
  if (file === config.guideFile) cached = result;
  return result;
}

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));

/** The guide's sections best matching a question (by its words), with every section's title. */
export function searchGuide(question: string, file?: string): { sections: Section[]; contents: string[] } {
  const all = guideSections(file);
  const asked = [...new Set(words(question))];
  const scored = all
    .map((section) => {
      const title = words(section.title);
      const body = words(section.text);
      const score = asked.reduce(
        (sum, w) => sum + title.filter((t) => t.startsWith(w)).length * 5 + Math.min(5, body.filter((b) => b.startsWith(w)).length),
        0,
      );
      return { section, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  const sections: Section[] = [];
  let size = 0;
  for (const { section } of scored) {
    if (sections.length && size + section.text.length > MAX_CHARS) break;
    sections.push(section.text.length > MAX_CHARS ? { ...section, text: `${section.text.slice(0, MAX_CHARS)}…` } : section);
    size += section.text.length;
    if (sections.length === 3) break;
  }
  return { sections, contents: all.map((s) => s.title) };
}
