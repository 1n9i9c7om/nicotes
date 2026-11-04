import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { EMPTY_CANVAS, type Page } from '@nicotes/shared';
import type { DrawingEnv } from '../editor/embed';
import { useAutosave } from '../editor/useAutosave';
import { api, uploadFile } from '../lib/api';
import { loadCanvasEditor } from '../lib/excalidraw';
import type { LinkBridge } from '../lib/links';
import { keys, usePage } from '../lib/queries';
import { displayTitle } from '../lib/tree';
import type { CanvasHandle } from './CanvasEditor';

const CanvasEditor = lazy(loadCanvasEditor);

/**
 * Drawings inside a page. A drawing is a canvas subpage shown by an `![[embed]]`, so it
 * exports and imports like any canvas; here it opens over the page and Done comes back.
 */
export function useDrawings(pageId: string, notebookId: string, bridge: LinkBridge) {
  const qc = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const place = useRef({ pageId, notebookId });
  place.current = { pageId, notebookId };
  const listeners = useRef(new Set<(pageId: string) => void>());

  const env = useMemo<DrawingEnv>(
    () => ({
      create: async () => {
        // Numbered across all pages, so `![[Drawing 3]]` can only mean this one.
        let n = 1;
        while (bridge.resolve(`Drawing ${n}`)) n++;
        const title = `Drawing ${n}`;
        const { pageId: parentId, notebookId: inNotebook } = place.current;
        const created = await api.post<Page>('/pages', { notebookId: inNotebook, parentId, title, content: EMPTY_CANVAS });
        await qc.refetchQueries({ queryKey: keys.pages });
        return { id: created.id, target: title };
      },
      open: setOpen,
      subscribe: (listener) => {
        listeners.current.add(listener);
        return () => listeners.current.delete(listener);
      },
    }),
    [bridge, qc],
  );

  const close = (id: string) => {
    setOpen(null);
    for (const listener of listeners.current) listener(id);
  };

  const dialog = open ? <DrawingDialog key={open} pageId={open} bridge={bridge} onClose={() => close(open)} /> : null;
  return { env, dialog };
}

function DrawingDialog({ pageId, bridge, onClose }: { pageId: string; bridge: LinkBridge; onClose: () => void }) {
  const page = usePage(pageId);
  return createPortal(
    <div className="drawing-dialog" role="dialog" aria-modal="true" aria-label="Drawing">
      {page.data ? (
        <DrawingEditor page={page.data} bridge={bridge} onClose={onClose} />
      ) : (
        <div className="drawing-bar">
          <span className="muted">{page.isError ? 'This drawing could not be loaded.' : 'Loading…'}</span>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}

function DrawingEditor({ page, bridge, onClose }: { page: Page; bridge: LinkBridge; onClose: () => void }) {
  const { content, setContent, status, revision, flush } = useAutosave(page);
  const upload = useCallback((file: File) => uploadFile(file, page.id), [page.id]);
  const canvas = useRef<CanvasHandle>(null);
  const [closing, setClosing] = useState(false);

  // Done closes once everything is written, so the page shows the finished drawing.
  useEffect(() => {
    if (closing && (status === 'saved' || status === 'local')) onClose();
  }, [closing, status, onClose]);

  const done = async () => {
    await canvas.current?.flush().catch(() => {});
    setClosing(true);
    void flush();
  };

  const trouble = status === 'error' ? 'Could not save.' : status === 'conflict' ? 'This drawing was changed elsewhere.' : null;

  return (
    <>
      <div className="drawing-bar">
        <span className="drawing-title">{displayTitle(page.title)}</span>
        {trouble && (
          <span className="error" role="alert">
            {trouble}
          </span>
        )}
        <button className="btn btn-primary" disabled={closing && !trouble} onClick={trouble ? onClose : () => void done()}>
          {trouble ? 'Close anyway' : 'Done'}
        </button>
      </div>
      <Suspense fallback={<div className="canvas-host canvas-loading" aria-busy="true" />}>
        <CanvasEditor key={`c${revision}`} handle={canvas} content={content} onChange={setContent} upload={upload} onOpenLink={(t) => bridge.open(t)} />
      </Suspense>
    </>
  );
}
