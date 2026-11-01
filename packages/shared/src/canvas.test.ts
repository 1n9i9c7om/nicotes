import { describe, expect, it } from 'vitest';
import { canvasMarkdown, EMPTY_CANVAS, isCanvas, parseCanvas } from './canvas';

describe('canvas pages', () => {
  it('are recognised by their frontmatter', () => {
    expect(isCanvas(EMPTY_CANVAS)).toBe(true);
    expect(isCanvas('---\ntags: [x]\nexcalidraw-plugin: parsed\n---\n')).toBe(true);
    expect(isCanvas('# Notes\n\nexcalidraw-plugin: parsed')).toBe(false);
    expect(isCanvas('---\ntitle: x\n---\nexcalidraw-plugin: parsed')).toBe(false);
  });

  it('keep texts, files and the scene apart', () => {
    const scene = 'N4Ig'.repeat(100);
    const md = canvasMarkdown(
      [
        { id: 'a1', text: 'Kitchen plan' },
        { id: 'b2', text: '  ' },
        { id: 'c3', text: 'See [[Budget]]' },
      ],
      [{ id: 'f-1', name: 'photo [1].png', url: '/api/attachments/x1/photo.png' }],
      scene,
    );
    expect(md).toContain('## Text Elements\nKitchen plan ^a1\n\nSee [[Budget]] ^c3\n\n## Embedded Files\nf-1: ![photo 1.png](/api/attachments/x1/photo.png)');
    expect(md.split('\n').every((line) => line.length <= 256)).toBe(true);
    expect(parseCanvas(md)).toEqual({
      drawing: { compressed: true, data: scene },
      files: [{ id: 'f-1', name: 'photo 1.png', url: '/api/attachments/x1/photo.png' }],
    });
  });

  it('read drawings saved by Obsidian as plain JSON', () => {
    const md = '---\nexcalidraw-plugin: parsed\n---\n## Embedded Files\nabc: [image.png](/api/attachments/q/image.png)\n\n%%\n## Drawing\n```json\n{"type":"excalidraw"}\n```\n%%';
    expect(parseCanvas(md)).toEqual({
      drawing: { compressed: false, data: '{"type":"excalidraw"}' },
      files: [{ id: 'abc', name: 'image.png', url: '/api/attachments/q/image.png' }],
    });
  });
});
