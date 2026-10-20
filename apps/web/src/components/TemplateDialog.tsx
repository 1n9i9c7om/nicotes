import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { FileText, LayoutTemplate } from 'lucide-react';
import { TEMPLATE_TAG } from '@nicotes/shared';
import { fromTemplate } from '../lib/daily';
import { useCreatePage, usePages, useSetPageTags } from '../lib/queries';
import { displayTitle } from '../lib/tree';
import { Modal } from './Modal';

interface Props {
  notebookId: string;
  parentId: string | null;
  onClose: () => void;
}

/** Creates a page from a template (any page tagged #template). */
export function TemplateDialog({ notebookId, parentId, onClose }: Props) {
  const pages = usePages();
  const createPage = useCreatePage();
  const setTags = useSetPageTags();
  const navigate = useNavigate();
  const templates = useMemo(
    () => (pages.data ?? []).filter((p) => p.tags.includes(TEMPLATE_TAG)).sort((a, b) => a.title.localeCompare(b.title)),
    [pages.data],
  );
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const chosen = templateId ?? templates[0]?.id ?? null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!chosen) return;
    try {
      const filled = await fromTemplate(chosen, title.trim());
      const page = await createPage.mutateAsync({ notebookId, parentId, title: title.trim(), content: filled.content });
      if (filled.tags.length) await setTags.mutateAsync({ id: page.id, tags: filled.tags });
      onClose();
      navigate(`/p/${page.id}`, { state: title.trim() ? undefined : { created: page } });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Modal title="New page from template" onClose={onClose}>
      {templates.length === 0 ? (
        <div className="stack">
          <p>
            No templates yet. Tag any page with <strong>#template</strong> to offer it here. Templates can use{' '}
            <code>{'{{date}}'}</code>, <code>{'{{time}}'}</code>, <code>{'{{weekday}}'}</code> and <code>{'{{title}}'}</code>.
          </p>
          <div className="modal-footer">
            <button className="btn" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      ) : (
        <form className="stack" onSubmit={submit}>
          <ul className="pick-list" role="radiogroup">
            {templates.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={t.id === chosen}
                  className={t.id === chosen ? 'pick-item active' : 'pick-item'}
                  onClick={() => setTemplateId(t.id)}
                >
                  {t.id === chosen ? <LayoutTemplate size={15} /> : <FileText size={15} />}
                  <span className="pick-label">{displayTitle(t.title)}</span>
                  <span className="pick-where">{t.tags.filter((x) => x !== TEMPLATE_TAG).map((x) => `#${x}`).join(' ')}</span>
                </button>
              </li>
            ))}
          </ul>
          <label className="field">
            <span>Title</span>
            <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Untitled" maxLength={300} />
          </label>
          {error && <p className="error">{error}</p>}
          <div className="modal-footer">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={createPage.isPending}>
              Create page
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
