import { useId, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { Hash, Plus, X } from 'lucide-react';
import { normalizeTag } from '@nicotes/shared';
import { useSetPageTags, useTags } from '../lib/queries';

/** Tag chips under the page title, with an inline input to add more. */
export function TagEditor({ pageId, tags }: { pageId: string; tags: string[] }) {
  const allTags = useTags();
  const setTags = useSetPageTags();
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState('');
  const listId = useId();

  const save = (next: string[]) => setTags.mutate({ id: pageId, tags: next });

  const add = () => {
    const tag = normalizeTag(value);
    setValue('');
    if (tag && !tags.includes(tag)) save([...tags, tag]);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add();
    } else if (e.key === 'Escape') {
      setValue('');
      setAdding(false);
    } else if (e.key === 'Backspace' && !value && tags.length) {
      save(tags.slice(0, -1));
    }
  };

  return (
    <div className="tag-editor">
      {tags.map((tag) => (
        <span key={tag} className="tag-chip">
          <Link to={`/t/${encodeURIComponent(tag)}`} className="tag-chip-link">
            <Hash size={12} />
            {tag}
          </Link>
          <button className="tag-chip-remove" aria-label={`Remove tag ${tag}`} onClick={() => save(tags.filter((t) => t !== tag))}>
            <X size={12} />
          </button>
        </span>
      ))}
      {adding ? (
        <>
          <input
            className="tag-input"
            autoFocus
            list={listId}
            placeholder="tag"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={() => {
              add();
              setAdding(false);
            }}
          />
          <datalist id={listId}>
            {allTags.data?.filter((t) => !tags.includes(t.name)).map((t) => <option key={t.name} value={t.name} />)}
          </datalist>
        </>
      ) : (
        <button className="tag-add" onClick={() => setAdding(true)}>
          <Plus size={12} /> {tags.length ? 'Tag' : 'Add tag'}
        </button>
      )}
    </div>
  );
}
