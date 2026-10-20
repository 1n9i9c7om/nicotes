import { useId, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { Hash, Plus, X } from 'lucide-react';
import { normalizeTag } from '@nicotes/shared';
import { useSetPageTags, useTags } from '../lib/queries';

/** Tag chips under the page title, saved to the page right away. */
export function TagEditor({ pageId, tags, inherited = [] }: { pageId: string; tags: string[]; inherited?: { name: string; from: string }[] }) {
  const setTags = useSetPageTags();
  return <TagChips tags={tags} inherited={inherited} onChange={(next) => setTags.mutate({ id: pageId, tags: next })} />;
}

/** Controlled tag chips with an inline input; `linked` makes chips open the tag hub. */
export function TagChips({
  tags,
  onChange,
  linked = true,
  inherited = [],
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  linked?: boolean;
  /** Tags inherited from an ancestor: shown dimmed, removable only there. */
  inherited?: { name: string; from: string }[];
}) {
  const allTags = useTags();
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState('');
  const listId = useId();

  const add = () => {
    const tag = normalizeTag(value);
    setValue('');
    if (tag && !tags.includes(tag)) onChange([...tags, tag]);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add();
    } else if (e.key === 'Escape') {
      setValue('');
      setAdding(false);
    } else if (e.key === 'Backspace' && !value && tags.length) {
      onChange(tags.slice(0, -1));
    }
  };

  return (
    <div className="tag-editor">
      {tags.map((tag) => (
        <span key={tag} className="tag-chip">
          {linked ? (
            <Link to={`/t/${encodeURIComponent(tag)}`} className="tag-chip-link">
              <Hash size={12} />
              {tag}
            </Link>
          ) : (
            <span className="tag-chip-link">
              <Hash size={12} />
              {tag}
            </span>
          )}
          <button
            type="button"
            className="tag-chip-remove"
            aria-label={`Remove tag ${tag}`}
            onClick={() => onChange(tags.filter((t) => t !== tag))}
          >
            <X size={12} />
          </button>
        </span>
      ))}
      {inherited.map((tag) => (
        <Link
          key={tag.name}
          to={`/t/${encodeURIComponent(tag.name)}`}
          className="tag-chip inherited"
          title={`Inherited from “${tag.from}”`}
        >
          <span className="tag-chip-link">
            <Hash size={12} />
            {tag.name}
          </span>
        </Link>
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
        <button type="button" className="tag-add" onClick={() => setAdding(true)}>
          <Plus size={12} /> {tags.length ? 'Tag' : 'Add tag'}
        </button>
      )}
    </div>
  );
}
