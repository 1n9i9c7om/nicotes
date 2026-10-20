import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { AlertTriangle, ArrowLeft, Download, Link2, Loader2, Settings as SettingsIcon, Sparkles, TextCursorInput } from 'lucide-react';
import {
  IMPORT_PROFILES,
  PROFILE_LABELS,
  type ImportPreview,
  type ImportProfile,
} from '@nicotes/shared';
import { TagChips } from '../components/TagEditor';
import { VisualEditor } from '../editor/VisualEditor';
import { uploadFile } from '../lib/api';
import { useLinkBridge } from '../lib/links';
import { useCreatePage, useImportPreview, useNotebooks, usePages, useSetPageTags } from '../lib/queries';
import { useLocalState } from '../lib/storage';
import { buildTree, displayTitle, rootKey, type PageTree } from '../lib/tree';

type Source = 'url' | 'text';

const STAGES = ['Fetching the page…', 'Reading the content…', 'Asking the model…', 'Formatting the note…'];

const METHOD_LABEL: Record<ImportPreview['method'], string> = {
  'structured-data': 'Recipe data embedded in the page',
  llm: 'Extracted by the model',
  clip: 'Page text clipped as-is',
};

/** Pages of a notebook in tree order, with their depth, for the parent picker. */
function flatten(tree: PageTree, notebookId: string) {
  const out: { id: string; title: string; depth: number }[] = [];
  const walk = (key: string, depth: number) => {
    for (const page of tree.children.get(key) ?? []) {
      out.push({ id: page.id, title: displayTitle(page.title), depth });
      walk(page.id, depth + 1);
    }
  };
  walk(rootKey(notebookId), 0);
  return out;
}

export function ImportPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const notebooks = useNotebooks();
  const pages = usePages();
  const preview = useImportPreview();
  const createPage = useCreatePage();
  const setTags = useSetPageTags();

  const [source, setSource] = useState<Source>(params.get('text') ? 'text' : 'url');
  const [url, setUrl] = useState(params.get('url') ?? '');
  const [text, setText] = useState(params.get('text') ?? '');
  const [profile, setProfile] = useState<'auto' | ImportProfile>('auto');
  const [fullText, setFullText] = useState(false);
  const [stage, setStage] = useState(0);

  const [lastNotebook, setLastNotebook] = useLocalState<string | null>('nicotes.importNotebook', null);
  const [notebookId, setNotebookId] = useState<string | null>(params.get('notebook'));
  const [parentId, setParentId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [tags, setTagList] = useState<string[]>([]);
  const markdown = useRef('');

  const tree = useMemo(() => buildTree(pages.data ?? []), [pages.data]);
  const targetNotebook =
    notebooks.data?.find((n) => n.id === (notebookId ?? lastNotebook)) ?? notebooks.data?.[0] ?? null;
  const parents = targetNotebook ? flatten(tree, targetNotebook.id) : [];
  const bridge = useLinkBridge(targetNotebook?.id ?? '');

  // Shared links (e.g. /import?url=…) start right away.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!autoStarted.current && params.get('url')) {
      autoStarted.current = true;
      run();
    }
  }, []);

  useEffect(() => {
    if (!preview.isPending) return;
    setStage(0);
    const timer = setInterval(() => setStage((s) => Math.min(s + 1, STAGES.length - 1)), 3500);
    return () => clearInterval(timer);
  }, [preview.isPending]);

  function run(e?: FormEvent) {
    e?.preventDefault();
    preview.mutate(
      source === 'url'
        ? { url: url.trim(), profile, includeFullText: fullText }
        : { text, profile, includeFullText: fullText },
      {
        onSuccess: (result) => {
          setTitle(result.title);
          setTagList(result.suggestedTags);
          markdown.current = result.markdown;
        },
      },
    );
  }

  async function save() {
    if (!targetNotebook) return;
    const page = await createPage.mutateAsync({
      notebookId: targetNotebook.id,
      parentId,
      title: title.trim(),
      content: markdown.current,
    });
    if (tags.length) await setTags.mutateAsync({ id: page.id, tags });
    setLastNotebook(targetNotebook.id);
    navigate(`/p/${page.id}`);
  }

  const result = preview.data;

  return (
    <div className="content import">
      <header className="content-header">
        <h1>
          <Download size={26} /> Import
        </h1>
        <p className="muted">Turn a web page into a note: recipes, articles, products, events or anything else.</p>
      </header>

      {!result && (
        <form className="import-card" onSubmit={run}>
          <div className="segmented" role="tablist">
            <button type="button" className={source === 'url' ? 'active' : ''} onClick={() => setSource('url')}>
              <Link2 size={15} /> <span>Link</span>
            </button>
            <button type="button" className={source === 'text' ? 'active' : ''} onClick={() => setSource('text')}>
              <TextCursorInput size={15} /> <span>Paste text</span>
            </button>
          </div>

          {source === 'url' ? (
            <input
              className="import-url"
              type="url"
              inputMode="url"
              required
              autoFocus
              placeholder="https://…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          ) : (
            <textarea
              className="import-text"
              required
              autoFocus
              rows={8}
              placeholder="Paste the text of a page that cannot be fetched…"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          )}

          <div className="field">
            <span>Kind of page</span>
            <div className="chips" role="radiogroup">
              {(['auto', ...IMPORT_PROFILES] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  aria-checked={profile === p}
                  className={profile === p ? 'chip active' : 'chip'}
                  onClick={() => setProfile(p)}
                >
                  {p === 'auto' ? (
                    <>
                      <Sparkles size={13} /> Detect
                    </>
                  ) : (
                    PROFILE_LABELS[p]
                  )}
                </button>
              ))}
            </div>
          </div>
          {(profile === 'article' || profile === 'auto') && (
            <label className="check-row">
              <input type="checkbox" checked={fullText} onChange={(e) => setFullText(e.target.checked)} />
              For articles, also keep the full text below the summary
            </label>
          )}

          {preview.error && (
            <div className="banner banner-warning" role="alert">
              <AlertTriangle size={18} />
              <span>{preview.error.message}</span>
            </div>
          )}

          <div className="import-actions">
            <Link to="/settings" className="btn">
              <SettingsIcon size={15} /> Settings
            </Link>
            <button className="btn btn-primary" disabled={preview.isPending}>
              {preview.isPending ? <Loader2 size={16} className="spin" /> : <Download size={16} />}
              {preview.isPending ? STAGES[stage] : 'Import'}
            </button>
          </div>
        </form>
      )}

      {result && (
        <div className="import-result">
          <div className="import-meta">
            <span className={`badge method-${result.method}`}>{METHOD_LABEL[result.method]}</span>
            <span className="badge">{PROFILE_LABELS[result.profile]}</span>
            <span className="badge">{result.extractor === 'crawl4ai' ? 'via crawl4ai' : result.extractor === 'readability' ? 'built-in fetch' : 'pasted text'}</span>
            {result.usage && (
              <span className="badge" title={`${result.usage.promptTokens} in · ${result.usage.completionTokens} out`}>
                {result.usage.model} · {(result.usage.promptTokens + result.usage.completionTokens).toLocaleString()} tokens
              </span>
            )}
          </div>
          {result.warnings.map((w) => (
            <div key={w} className="banner banner-warning">
              <AlertTriangle size={18} />
              <span>{w}</span>
            </div>
          ))}

          <div className="import-target">
            <label className="field">
              <span>Notebook</span>
              <select
                value={targetNotebook?.id ?? ''}
                onChange={(e) => {
                  setNotebookId(e.target.value);
                  setParentId(null);
                }}
              >
                {notebooks.data?.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Inside page</span>
              <select value={parentId ?? ''} onChange={(e) => setParentId(e.target.value || null)}>
                <option value="">— Top level —</option>
                {parents.map((p) => (
                  <option key={p.id} value={p.id}>
                    {' '.repeat(p.depth)}
                    {p.title}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <input
            className="page-title import-title"
            value={title}
            placeholder="Untitled"
            aria-label="Title"
            onChange={(e) => setTitle(e.target.value)}
          />
          <TagChips tags={tags} onChange={setTagList} linked={false} />
          <div className="import-editor">
            <VisualEditor
              key={result.markdown}
              initialContent={result.markdown}
              onChange={(md) => (markdown.current = md)}
              bridge={bridge}
              upload={(file) => uploadFile(file)}
            />
          </div>

          <div className="import-actions sticky">
            <button className="btn" onClick={() => preview.reset()}>
              <ArrowLeft size={15} /> Start over
            </button>
            <button
              className="btn btn-primary"
              disabled={!targetNotebook || createPage.isPending}
              onClick={() => void save()}
            >
              Save page
            </button>
          </div>
          {!notebooks.data?.length && <p className="error">Create a notebook first to save imported pages.</p>}
        </div>
      )}
    </div>
  );
}
