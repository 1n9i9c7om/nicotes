import { useState, type FormEvent } from 'react';
import type { Notebook } from '@nicotes/shared';
import { useCreateNotebook, useUpdateNotebook } from '../lib/queries';
import { Modal } from './Modal';

export const NOTEBOOK_COLORS = [
  '#22d3ee', // cyan
  '#3b82f6', // blue
  '#818cf8', // indigo
  '#a78bfa', // violet
  '#2dd4bf', // teal
  '#4ade80', // green
  '#fbbf24', // amber
  '#fb7185', // rose
  '#94a3b8', // slate
];

interface Props {
  notebook?: Notebook;
  onClose: () => void;
  onCreated?: (notebook: Notebook) => void;
}

export function NotebookDialog({ notebook, onClose, onCreated }: Props) {
  const [title, setTitle] = useState(notebook?.title ?? '');
  const [color, setColor] = useState(notebook?.color ?? NOTEBOOK_COLORS[0]!);
  const create = useCreateNotebook();
  const update = useUpdateNotebook();
  const error = create.error ?? update.error;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (notebook) {
      await update.mutateAsync({ id: notebook.id, title, color });
    } else {
      onCreated?.(await create.mutateAsync({ title, color }));
    }
    onClose();
  };

  return (
    <Modal title={notebook ? 'Edit notebook' : 'New notebook'} onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <label className="field">
          <span>Name</span>
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
        </label>
        <div className="field">
          <span>Colour</span>
          <div className="swatches" role="radiogroup" aria-label="Colour">
            {NOTEBOOK_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={c === color}
                aria-label={c}
                className="swatch"
                style={{ background: c }}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
        </div>
        {error && <p className="error">{error.message}</p>}
        <div className="modal-footer">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={create.isPending || update.isPending}>
            {notebook ? 'Save' : 'Create'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
