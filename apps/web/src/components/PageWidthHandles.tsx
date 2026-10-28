import { useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';

export const MIN_PAGE_WIDTH = 560;
const STEP = 40;

interface Props {
  /** The centred page body being resized. */
  body: RefObject<HTMLElement | null>;
  /** Stored width in px, or null for the default (--content-width). */
  width: number | null;
  onChange: (width: number | null) => void;
}

/**
 * Drag handles on both edges of the page body. The body stays centred, so it grows by twice the
 * pointer movement and the grabbed edge stays under the pointer. Double-click resets the width.
 */
export function PageWidthHandles({ body, width, onChange }: Props) {
  const drag = useRef<{ x: number; width: number; max: number } | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);

  const current = () => body.current?.getBoundingClientRect().width ?? width ?? MIN_PAGE_WIDTH;
  const available = () => body.current?.parentElement?.clientWidth ?? Infinity;
  const clamp = (value: number, max: number) => Math.round(Math.max(MIN_PAGE_WIDTH, Math.min(value, max)));

  const start = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, width: current(), max: available() };
    setDragging(drag.current.width);
  };

  const move = (e: PointerEvent<HTMLDivElement>, side: 1 | -1) => {
    if (!drag.current) return;
    const next = clamp(drag.current.width + 2 * side * (e.clientX - drag.current.x), drag.current.max);
    setDragging(next);
    onChange(next);
  };

  const end = () => {
    drag.current = null;
    setDragging(null);
  };

  const key = (e: KeyboardEvent<HTMLDivElement>, side: 1 | -1) => {
    const delta = e.key === 'ArrowRight' ? STEP * side : e.key === 'ArrowLeft' ? -STEP * side : 0;
    if (e.key === 'Home') onChange(null);
    else if (delta) onChange(clamp(current() + 2 * delta, available()));
    else return;
    e.preventDefault();
  };

  return (['left', 'right'] as const).map((edge) => {
    const side = edge === 'right' ? 1 : -1;
    return (
      <div
        key={edge}
        className={`page-width-handle ${edge}${dragging !== null ? ' dragging' : ''}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="Page width"
        aria-valuemin={MIN_PAGE_WIDTH}
        aria-valuenow={Math.round(dragging ?? width ?? current())}
        title="Drag to change the page width · double-click to reset"
        tabIndex={0}
        onPointerDown={start}
        onPointerMove={(e) => move(e, side)}
        onPointerUp={end}
        onPointerCancel={end}
        onDoubleClick={() => onChange(null)}
        onKeyDown={(e) => key(e, side)}
      >
        {dragging !== null && edge === 'right' && <span className="page-width-label">{dragging} px</span>}
      </div>
    );
  });
}
