import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, FolderArchive, Loader2, Upload } from 'lucide-react';
import { Link } from 'react-router';
import type { VaultImportMode, VaultImportResult, VaultPreview } from '@nicotes/shared';
import { api, postFile } from '../lib/api';

const plural = (n: number, word: string) => `${n.toLocaleString('en')} ${word}${n === 1 ? '' : 's'}`;

/** Import page: a zipped Obsidian vault (or a Nicotes export), previewed before it is imported. */
export function VaultImport() {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<VaultImportMode>('notebooks');
  const preview = useMutation({ mutationFn: (file: File) => postFile<VaultPreview>('/import/vault/preview', file) });
  const run = useMutation({
    mutationFn: (p: VaultPreview) => api.post<VaultImportResult>('/import/vault', { id: p.id, mode }),
    // New notebooks, pages, tags and tasks everywhere.
    onSuccess: () => qc.invalidateQueries(),
  });
  const reset = () => {
    preview.reset();
    run.reset();
    if (input.current) input.current.value = '';
  };

  const p = preview.data;
  const done = run.data;
  const error = preview.error ?? run.error;

  return (
    <section className="import-card vault-import">
      <h2>
        <FolderArchive size={18} /> Obsidian vault or Markdown folder
      </h2>
      <p className="muted">
        Zip the vault's folder (or use a Nicotes export) and choose the zip. Notes become pages, folders become notebooks
        or parent pages, and the images and files your notes use come along. <code>[[Links]]</code>, tags and properties
        are kept.
      </p>

      {!p && !done && (
        <div className="import-actions">
          <input
            ref={input}
            type="file"
            accept=".zip,application/zip"
            hidden
            aria-label="Vault zip"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) preview.mutate(file);
            }}
          />
          <button type="button" className="btn" disabled={preview.isPending} onClick={() => input.current?.click()}>
            {preview.isPending ? <Loader2 size={16} className="spin" /> : <Upload size={16} />}
            {preview.isPending ? 'Reading the zip…' : 'Choose a zip'}
          </button>
        </div>
      )}

      {p && !done && (
        <div className="vault-preview">
          <p>
            <strong>{p.name}</strong>: {plural(p.notes, 'note')}, {plural(p.attachments, 'file')}, {plural(p.tags, 'tag')}
          </p>
          <div className="vault-modes" role="radiogroup" aria-label="Layout">
            <label className="check-row">
              <input type="radio" name="vault-mode" checked={mode === 'notebooks'} onChange={() => setMode('notebooks')} />A
              notebook for each top-level folder
            </label>
            {mode === 'notebooks' && (
              <ul className="vault-notebooks">
                {p.notebooks.map((n) => (
                  <li key={n.title}>
                    {n.title} <span className="muted">· {plural(n.pages, 'page')}</span>
                    {n.exists && <span className="muted"> · you have one of that name, so this one is called “{n.title} (imported)”</span>}
                  </li>
                ))}
              </ul>
            )}
            <label className="check-row">
              <input type="radio" name="vault-mode" checked={mode === 'single'} onChange={() => setMode('single')} />
              Everything in one notebook, “{p.name}”
            </label>
          </div>
          {p.unresolvedLinks > 0 && (
            <p className="setting-hint">
              {plural(p.unresolvedLinks, 'link')} {p.unresolvedLinks === 1 ? 'points' : 'point'} to notes that are not in
              the zip; they stay as links to pages you can create later.
            </p>
          )}
          {p.skippedCount > 0 && (
            <details className="vault-skipped">
              <summary>{plural(p.skippedCount, 'file')} left out</summary>
              <ul>
                {p.skipped.map((s) => (
                  <li key={s.path}>
                    {s.path} <span className="muted">· {s.reason}</span>
                  </li>
                ))}
                {p.skippedCount > p.skipped.length && <li className="muted">and {p.skippedCount - p.skipped.length} more</li>}
              </ul>
            </details>
          )}
          <div className="import-actions">
            <button type="button" className="btn" disabled={run.isPending} onClick={reset}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" disabled={run.isPending} onClick={() => run.mutate(p)}>
              {run.isPending ? <Loader2 size={16} className="spin" /> : <FolderArchive size={16} />}
              {run.isPending ? 'Importing…' : `Import ${plural(p.notes, 'note')}`}
            </button>
          </div>
        </div>
      )}

      {done && (
        <div className="vault-done" role="status">
          <p className="check ok">
            <CheckCircle2 size={15} /> Imported {plural(done.pages, 'page')}, {plural(done.attachments, 'file')} and{' '}
            {plural(done.tags, 'tag')} into{' '}
            {done.notebooks.map((n, i) => (
              <span key={n.id}>
                {i > 0 && ', '}
                <Link to={`/n/${n.id}`}>{n.title}</Link>
              </span>
            ))}
            .
          </p>
          <button type="button" className="link-btn" onClick={reset}>
            Import another zip
          </button>
        </div>
      )}

      {error && (
        <div className="banner banner-warning" role="alert">
          <AlertTriangle size={18} />
          <span>{error.message}</span>
        </div>
      )}
    </section>
  );
}
