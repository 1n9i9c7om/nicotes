import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
import { AI_PROVIDER_LABELS, providerOf, type AiProvider, type ModelInfo } from '@nicotes/shared';

type Capability = 'all' | 'tools' | 'reasoning' | 'free';
type Service = 'both' | AiProvider;

const CAPABILITIES: { key: Capability; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'tools', label: 'Supports tools' },
  { key: 'reasoning', label: 'Supports reasoning' },
  { key: 'free', label: 'Free' },
];
const SERVICES: { key: Service; label: string }[] = [
  { key: 'both', label: 'Both services' },
  { key: 'openrouter', label: AI_PROVIDER_LABELS.openrouter },
  { key: 'routeway', label: AI_PROVIDER_LABELS.routeway },
];
/** Rendering hundreds of rows at once is slow; the search narrows it down. */
const MAX_ROWS = 150;

const contextLabel = (tokens: number) => `${Math.round(tokens / 1000)}k context`;
const priceLabel = (usd: number) => `$${usd >= 100 ? usd.toFixed(0) : usd.toPrecision(3)}`;

/** "164k context · $0.500 in / $2.15 out per 1M" */
export function modelDetails(m: ModelInfo) {
  const parts: string[] = [];
  if (m.contextLength) parts.push(contextLabel(m.contextLength));
  if (m.free) parts.push('free');
  else if (m.promptPrice !== null) {
    parts.push(
      m.completionPrice !== null
        ? `${priceLabel(m.promptPrice)} in / ${priceLabel(m.completionPrice)} out per 1M`
        : `${priceLabel(m.promptPrice)} per 1M`,
    );
  }
  return parts.join(' · ');
}

function ServiceBadge({ provider }: { provider: AiProvider }) {
  return <span className={`model-badge ${provider}`}>{AI_PROVIDER_LABELS[provider]}</span>;
}

interface Props {
  /** The stored model id; null when the default applies. */
  value: string | null;
  /** Shown while nothing is chosen, e.g. "Default · z-ai/glm-5.3-flashx". */
  placeholder: string;
  models?: ModelInfo[];
  loading?: boolean;
  /** Offer going back to the default model (per-feature models). */
  allowDefault?: boolean;
  /** Capability and service filters (off for the embedding models). */
  filters?: boolean;
  label: string;
  id?: string;
  disabled?: boolean;
  onChange: (id: string | null) => void;
  onRefresh?: () => void;
  refreshing?: boolean;
}

type Row = { kind: 'default' } | { kind: 'custom'; id: string } | { kind: 'model'; model: ModelInfo };

/** A searchable model list with capability and service filters (OpenRouter and Routeway). */
export function ModelPicker({
  value,
  placeholder,
  models,
  loading,
  allowDefault,
  filters = true,
  label,
  id,
  disabled,
  onChange,
  onRefresh,
  refreshing,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [capability, setCapability] = useState<Capability>('all');
  const [service, setService] = useState<Service>('both');
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const selected = value ? models?.find((m) => m.id === value) : undefined;

  const matching = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return (models ?? []).filter(
      (m) =>
        (capability === 'all' || m[capability]) &&
        (service === 'both' || m.provider === service) &&
        words.every((w) => m.name.toLowerCase().includes(w) || m.id.toLowerCase().includes(w)),
    );
  }, [models, query, capability, service]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = allowDefault && !query ? [{ kind: 'default' }] : [];
    out.push(...matching.slice(0, MAX_ROWS).map((model) => ({ kind: 'model' as const, model })));
    // Any id can be used, e.g. a model that is not listed yet: offered for id-like input.
    const typed = query.trim();
    const idLike = /[/:]/.test(typed) || matching.length === 0;
    if (typed && idLike && !/\s/.test(typed) && !models?.some((m) => m.id === typed)) out.push({ kind: 'custom', id: typed });
    return out;
  }, [allowDefault, query, matching, models]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Open on the selected model.
  useEffect(() => {
    if (!open) return;
    const index = rows.findIndex((r) => (r.kind === 'model' ? r.model.id === value : r.kind === 'default' && !value));
    setActive(Math.max(0, index));
  }, [open]);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const choose = (row: Row) => {
    onChange(row.kind === 'default' ? null : row.kind === 'custom' ? row.id : row.model.id);
    setOpen(false);
    setQuery('');
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') setActive((i) => Math.min(rows.length - 1, i + 1));
    else if (e.key === 'ArrowUp') setActive((i) => Math.max(0, i - 1));
    else if (e.key === 'Enter' && rows[active]) choose(rows[active]);
    else if (e.key === 'Escape') setOpen(false);
    else return;
    e.preventDefault();
  };

  const listId = `${id ?? label}-models`;

  return (
    <div className="model-picker" ref={root}>
      <button
        type="button"
        id={id}
        className="model-picker-trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        <span className={`model-picker-value${value ? '' : ' placeholder'}`}>{value ? (selected?.name ?? value) : placeholder}</span>
        {value && <ServiceBadge provider={selected?.provider ?? providerOf(value)} />}
        <ChevronDown size={15} className="model-picker-chevron" />
      </button>

      {open && (
        <div className="model-picker-panel">
          <input
            autoFocus
            className="model-picker-search"
            placeholder="Search models or type an id…"
            aria-label="Search models"
            aria-controls={listId}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKey}
          />
          {filters && (
            <>
              <div className="model-picker-chips" role="group" aria-label="Capabilities">
                {CAPABILITIES.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    className={capability === c.key ? 'active' : ''}
                    aria-pressed={capability === c.key}
                    onClick={() => (setCapability(c.key), setActive(0))}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
              <div className="model-picker-chips" role="group" aria-label="Services">
                {SERVICES.map((s) => (
                  <button
                    key={s.key}
                    type="button"
                    className={service === s.key ? 'active' : ''}
                    aria-pressed={service === s.key}
                    onClick={() => (setService(s.key), setActive(0))}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </>
          )}

          <ul className="model-picker-list" role="listbox" id={listId} aria-label={label} ref={list}>
            {loading && !models && (
              <li className="model-picker-empty">
                <Loader2 size={14} className="spin" /> Loading models…
              </li>
            )}
            {!loading && matching.length === 0 && <li className="model-picker-empty">No model matches.</li>}
            {rows.map((row, i) => {
              const isSelected = row.kind === 'model' ? row.model.id === value : row.kind === 'default' && !value;
              return (
                <li
                  key={row.kind === 'model' ? row.model.id : row.kind}
                  data-index={i}
                  role="option"
                  aria-selected={isSelected}
                  className={`model-option${isSelected ? ' selected' : ''}${i === active ? ' active' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(row)}
                >
                  {row.kind === 'default' && (
                    <span className="model-option-text">
                      <span className="model-option-name">Use the default model</span>
                      <span className="model-option-details">{placeholder}</span>
                    </span>
                  )}
                  {row.kind === 'custom' && (
                    <span className="model-option-text">
                      <span className="model-option-name">Use “{row.id}”</span>
                      <span className="model-option-details">
                        Not in the lists; used as {providerOf(row.id) === 'routeway' ? 'a Routeway' : 'an OpenRouter'} model
                        id (prefix Routeway ids with “routeway:”).
                      </span>
                    </span>
                  )}
                  {row.kind === 'model' && (
                    <>
                      <span className="model-option-text">
                        <span className="model-option-name">{row.model.name}</span>
                        <span className="model-option-id">{row.model.id}</span>
                        <span className="model-option-details">{modelDetails(row.model)}</span>
                      </span>
                      <ServiceBadge provider={row.model.provider} />
                    </>
                  )}
                </li>
              );
            })}
          </ul>

          <div className="model-picker-foot">
            <span>
              {Math.min(matching.length, MAX_ROWS) < matching.length
                ? `First ${MAX_ROWS} of ${matching.length} matches · ${models?.length ?? 0} models`
                : `${matching.length} of ${models?.length ?? 0} models`}
            </span>
            {onRefresh && (
              <button type="button" className="link-btn" disabled={refreshing} onClick={onRefresh}>
                {refreshing ? 'Refreshing…' : 'Refresh'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
