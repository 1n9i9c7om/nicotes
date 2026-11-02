/**
 * Canvas pages (free drawing, shapes, text and images) are stored the way Obsidian's
 * Excalidraw plugin stores drawings, so they export and import as `.excalidraw.md`:
 *
 *   ---
 *   excalidraw-plugin: parsed
 *   ---
 *   # Excalidraw Data
 *   ## Text Elements
 *   Kitchen plan ^h3Kd9s      ← every text, for search and [[links]]
 *   ## Embedded Files
 *   f1a2: ![photo.png](/api/attachments/…)   ← images, as attachments
 *   %%
 *   ## Drawing
 *   ```compressed-json
 *   N4Ig…                     ← the Excalidraw scene, LZString base64
 *   ```
 *   %%
 */

/** Frontmatter at the very top that names the Excalidraw plugin. */
export const isCanvas = (content: string) => /^---[ \t]*\r?\n(?:(?!---)[^\n]*\n)*?excalidraw-plugin:/.test(content.slice(0, 2000));

export interface CanvasText {
  /** The element's id. */
  id: string;
  text: string;
}

export interface CanvasFile {
  /** Excalidraw's file id, which image elements refer to. */
  id: string;
  name: string;
  url: string;
}

const chunks = (text: string, size: number) => text.match(new RegExp(`.{1,${size}}`, 'g')) ?? [];

/** A canvas page's Markdown; `drawing` is the scene, compressed (LZString, base64). */
export function canvasMarkdown(texts: CanvasText[], files: CanvasFile[], drawing: string): string {
  const lines = ['---', '', 'excalidraw-plugin: parsed', '', '---', '', '# Excalidraw Data', '', '## Text Elements'];
  for (const t of texts) if (t.text.trim()) lines.push(`${t.text.trim()} ^${t.id}`, '');
  if (files.length) {
    lines.push('## Embedded Files');
    for (const f of files) lines.push(`${f.id}: ![${f.name.replace(/[[\]]/g, '')}](${f.url})`, '');
  }
  lines.push('%%', '## Drawing', '```compressed-json', ...chunks(drawing, 256), '```', '%%', '');
  return lines.join('\n');
}

/** An empty canvas. */
export const EMPTY_CANVAS = canvasMarkdown([], [], '');

/** The scene and the image files of a canvas page (also of drawings made in Obsidian). */
export function parseCanvas(content: string): { drawing: { compressed: boolean; data: string } | null; files: CanvasFile[] } {
  const m = /## Drawing[ \t]*\r?\n```(compressed-json|json)[ \t]*\r?\n([\s\S]*?)\r?\n?```/.exec(content);
  const section = /## Embedded Files[ \t]*\r?\n([\s\S]*?)(?=\n%%|\n#{1,2} |$)/.exec(content)?.[1] ?? '';
  const files: CanvasFile[] = [];
  for (const f of section.matchAll(/^([\w-]+):\s*!?\[([^\]]*)\]\(<?([^)>\s]+)>?\)/gm)) {
    files.push({ id: f[1]!, name: f[2]!, url: f[3]! });
  }
  return {
    drawing: m ? { compressed: m[1] === 'compressed-json', data: m[1] === 'compressed-json' ? m[2]!.replace(/\s+/g, '') : m[2]! } : null,
    files,
  };
}
