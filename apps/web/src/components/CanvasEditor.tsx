import { useEffect, useMemo, useRef } from 'react';
import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import type { BinaryFileData, BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { Attachment, CanvasFile } from '@nicotes/shared';
import { readCanvas, writeCanvas, type Scene, type SceneElement } from '../lib/canvas';


interface Props {
  content: string;
  /** Called with the page's new Markdown, a moment after the drawing changes. */
  onChange?: (markdown: string) => void;
  /** Stores images pasted into the canvas as attachments. */
  upload?: (file: File) => Promise<Attachment>;
  /** `[[Page]]` links on shapes. */
  onOpenLink?: (target: string) => void;
  readOnly?: boolean;
}

const dataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

const extension = (mime: string) => mime.split('/')[1]?.replace('jpeg', 'jpg').replace('svg+xml', 'svg') ?? 'png';

/**
 * A canvas page: Excalidraw (pen, shapes, text, images) on the whole width. Loaded on demand,
 * as it is large. Images live as attachments and are fetched into the scene when it opens.
 */
export default function CanvasEditor({ content, onChange, upload, onOpenLink, readOnly = false }: Props) {
  // The first content only: afterwards the drawing is the truth, and the page remounts the
  // editor when its content is replaced (history, conflicts).
  const initial = useMemo(() => readCanvas(content), []);
  const files = useRef(new Map<string, CanvasFile>(initial.files.map((f) => [f.id, f])));
  const uploading = useRef(new Map<string, Promise<void>>());
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  const last = useRef(content);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef<{ elements: readonly SceneElement[]; appState: Scene['appState']; binary: BinaryFiles } | null>(null);

  // Images of the page, into the scene.
  useEffect(() => {
    let live = true;
    const load = async () => {
      const loaded: BinaryFileData[] = [];
      for (const f of initial.files) {
        try {
          const blob = await (await fetch(f.url)).blob();
          loaded.push({ id: f.id as BinaryFileData['id'], dataURL: (await dataUrl(blob)) as BinaryFileData['dataURL'], mimeType: blob.type as BinaryFileData['mimeType'], created: Date.now() });
        } catch {
          // A missing file shows as an empty image.
        }
      }
      if (live && loaded.length) api.current?.addFiles(loaded);
    };
    void load();
    return () => {
      live = false;
    };
  }, [initial]);

  const save = async () => {
    const state = latest.current;
    if (!state || !onChange) return;
    // New images (pasted or dropped) become attachments first.
    for (const el of state.elements) {
      const id = el.fileId;
      if (el.isDeleted || !id || files.current.has(id) || !upload) continue;
      const binary = state.binary[id];
      if (!binary) continue;
      if (!uploading.current.has(id)) {
        uploading.current.set(
          id,
          (async () => {
            const blob = await (await fetch(binary.dataURL)).blob();
            const name = `canvas-image.${extension(binary.mimeType)}`;
            const att = await upload(new File([blob], name, { type: binary.mimeType }));
            files.current.set(id, { id, name: att.filename, url: att.url });
          })().finally(() => uploading.current.delete(id)),
        );
      }
      await uploading.current.get(id);
    }
    const markdown = writeCanvas({ elements: state.elements, appState: state.appState }, [...files.current.values()]);
    if (markdown !== last.current) {
      last.current = markdown;
      onChange(markdown);
    }
  };

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <div className="canvas-host">
      <Excalidraw
        excalidrawAPI={(instance) => (api.current = instance)}
        initialData={{
          elements: initial.scene.elements as never,
          appState: {
            theme: 'dark',
            ...(initial.scene.appState.viewBackgroundColor ? { viewBackgroundColor: initial.scene.appState.viewBackgroundColor } : {}),
            ...(initial.scene.appState.gridSize ? { gridSize: initial.scene.appState.gridSize } : {}),
          },
          scrollToContent: true,
        }}
        theme="dark"
        viewModeEnabled={readOnly}
        UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, toggleTheme: false } }}
        onChange={(elements, appState, binary) => {
          if (readOnly) return;
          latest.current = { elements: elements as unknown as readonly SceneElement[], appState, binary };
          // Excalidraw reports every pointer move; the page is written once things settle.
          clearTimeout(timer.current);
          timer.current = setTimeout(() => void save(), 600);
        }}
        onLinkOpen={(element, event) => {
          const link = element.link ?? '';
          const target = /^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/.exec(link)?.[1];
          if (target && onOpenLink) {
            event.preventDefault();
            onOpenLink(target.trim());
          }
        }}
      />
    </div>
  );
}
