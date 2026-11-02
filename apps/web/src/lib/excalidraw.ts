/**
 * Loads the canvas editor. Excalidraw works out its font addresses while its modules load,
 * so what it reads has to be in place before the import starts.
 */
export function loadCanvasEditor() {
  prepare();
  return import('../components/CanvasEditor');
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
