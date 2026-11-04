import { compressToBase64, decompressFromBase64 } from 'lz-string';
import { canvasMarkdown, parseCanvas, type CanvasFile } from '@nicotes/shared';

/** The parts of an Excalidraw scene a canvas page keeps. */
export interface Scene {
  elements: readonly SceneElement[];
  appState: { viewBackgroundColor?: string; gridSize?: number | null };
}

/** What the page needs to know of an element; the rest is kept as Excalidraw wrote it. */
export interface SceneElement {
  id: string;
  type: string;
  isDeleted?: boolean;
  text?: string;
  link?: string | null;
  fileId?: string | null;
  [key: string]: unknown;
}

/** The scene and the image files of a canvas page. */
export function readCanvas(content: string): { scene: Scene; files: CanvasFile[] } {
  const { drawing, files } = parseCanvas(content);
  const empty: Scene = { elements: [], appState: {} };
  if (!drawing?.data) return { scene: empty, files };
  try {
    const json = drawing.compressed ? decompressFromBase64(drawing.data) : drawing.data;
    const data = JSON.parse(json ?? '') as Partial<Scene>;
    return { scene: { elements: data.elements ?? [], appState: data.appState ?? {} }, files };
  } catch {
    return { scene: empty, files };
  }
}

const dataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

/** The images of a canvas page as Excalidraw wants them; a missing one is left out. */
export async function fetchCanvasFiles(files: CanvasFile[]) {
  const loaded: { id: string; dataURL: string; mimeType: string; created: number }[] = [];
  for (const f of files) {
    try {
      const blob = await (await fetch(f.url)).blob();
      loaded.push({ id: f.id, dataURL: await dataUrl(blob), mimeType: blob.type, created: Date.now() });
    } catch {
      // A missing file shows as an empty image.
    }
  }
  return loaded;
}

/** A canvas page's Markdown for a scene: texts (and links) for search, the scene compressed. */
export function writeCanvas(scene: Scene, files: CanvasFile[]): string {
  const elements = scene.elements.filter((e) => !e.isDeleted);
  const texts = elements.flatMap((e) => {
    const parts = [e.type === 'text' ? (e.text ?? '') : '', e.link?.startsWith('[[') ? e.link : ''].filter(Boolean);
    return parts.length ? [{ id: e.id, text: parts.join(' ') }] : [];
  });
  const used = new Set(elements.map((e) => e.fileId).filter(Boolean));
  const data = {
    type: 'excalidraw',
    version: 2,
    source: 'nicotes',
    elements,
    appState: { viewBackgroundColor: scene.appState.viewBackgroundColor, gridSize: scene.appState.gridSize ?? null },
    files: {},
  };
  return canvasMarkdown(
    texts,
    files.filter((f) => used.has(f.id)),
    compressToBase64(JSON.stringify(data)),
  );
}
