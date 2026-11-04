import { fetchCanvasFiles, readCanvas } from './canvas';

/**
 * Loads the canvas editor. Excalidraw works out its font addresses while its modules load,
 * so what it reads has to be in place before the import starts.
 */
export function loadCanvasEditor() {
  prepare();
  return import('../components/CanvasEditor');
}

/**
 * A canvas page's drawing as a picture (null when it's empty), for showing it inside a page.
 * Light colours on no background: the styles turn it dark on screen and leave it for printing.
 */
export async function drawingSvg(content: string): Promise<SVGSVGElement | null> {
  const { scene, files } = readCanvas(content);
  const elements = scene.elements.filter((e) => !e.isDeleted);
  if (!elements.length) return null;
  prepare();
  const [{ exportToSvg }, loaded] = await Promise.all([import('@excalidraw/excalidraw'), fetchCanvasFiles(files)]);
  return exportToSvg({
    elements: elements as never,
    appState: { exportBackground: false, exportWithDarkMode: false },
    files: Object.fromEntries(loaded.map((f) => [f.id, f])) as never,
    exportPadding: 12,
  });
}

let prepared = false;

function prepare() {
  if (prepared) return;
  prepared = true;
  // Fonts come from this server (copied there at build time).
  (window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = '/excalidraw/';

  // Each font also names a CDN as fallback. Chrome checks every address of a FontFace
  // against the CSP when it is created, which blocks the CDN with one console error per
  // font (230): only this server's addresses are kept.
  const Native = window.FontFace;
  const ownOnly = (src: string) =>
    src
      .split(/,\s*(?=url\()/)
      .filter((part) => !/url\(["']?https?:/.test(part) || part.includes(window.location.origin))
      .join(', ') || src;
  window.FontFace = class extends Native {
    constructor(family: string, source: string | BufferSource, descriptors?: FontFaceDescriptors) {
      super(family, typeof source === 'string' ? ownOnly(source) : source, descriptors);
    }
  };
}
