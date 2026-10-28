import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { CalendarDays, Check, CheckCircle2, Copy, Cpu, Info, ListChecks, Sparkles, ExternalLink, FileDown, LogOut, PlugZap, RotateCcw, Smartphone, Telescope, XCircle } from 'lucide-react';
import { READ_SCOPE_INFO, READ_SCOPES, TEMPLATE_TAG, type ReadScope } from '@nicotes/shared';
import { displayTitle } from '../lib/tree';
import { formatDuration, formatSize, timeAgo } from '../lib/format';
import {
  AI_TASK_INFO,
  AI_TASKS,
  DEFAULT_OPENROUTER_MODEL,
  modelSetting,
  type ConnectionCheck,
  type ModelInfo,
  type Settings,
  type SettingSource,
  type SettingsUpdate,
} from '@nicotes/shared';
import { formatCost } from '../components/JobProgress';
import { SettingsBackups } from '../components/SettingsBackups';
import {
  exportUrl,
  useAuthStatus,
  useBatches,
  useCheckConnection,
  useModels,
  useNotebooks,
  usePages,
  useSemanticAction,
  useSemanticStatus,
  useSettings,
  useSignOut,
  useSystemInfo,
  useUndoBatch,
  useUpdateSettings,
} from '../lib/queries';
import { useInstallPrompt } from '../lib/install';

const SOURCE_LABEL: Record<Exclude<SettingSource, null>, string> = {
  settings: 'Saved here',
  env: 'From environment variable',
  default: 'Default',
};

function Source({ source, unset = 'Not set' }: { source: SettingSource; unset?: string }) {
  return <span className={`source source-${source ?? 'none'}`}>{source ? SOURCE_LABEL[source] : unset}</span>;
}

function CheckResult({ result }: { result?: ConnectionCheck }) {
  if (!result) return null;
  return (
    <p className={result.ok ? 'check ok' : 'check fail'} role="status">
      {result.ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
      {result.message}
    </p>
  );
}

/**
 * One editable value: shows where the current value comes from; saving an empty field
 * (or "Clear") removes the stored value so the environment/default applies again.
 */
function SettingField({
  label,
  hint,
  source,
  current,
  secret,
  placeholder,
  listId,
  allowEmpty,
  unsetLabel,
  onSave,
  pending,
}: {
  label: string;
  hint?: ReactNode;
  source: SettingSource;
  current: string | null;
  secret?: boolean;
  placeholder?: string;
  listId?: string;
  /** Saving an empty field stores "" (e.g. an empty list); only "Clear" restores the default. */
  allowEmpty?: boolean;
  /** Badge text while nothing is set, e.g. "Uses default". */
  unsetLabel?: string;
  onSave: (value: string | null) => void;
  pending: boolean;
}) {
  const [value, setValue] = useState(secret ? '' : (current ?? ''));
  const inputId = useId();
  const dirty = secret ? value !== '' : value !== (current ?? '');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSave(value.trim() || (allowEmpty ? '' : null));
    if (secret) setValue('');
  };

  return (
    <form className="setting" onSubmit={submit}>
      <div className="setting-head">
        <label className="setting-label" htmlFor={inputId}>
          {label}
        </label>
        <Source source={source} unset={unsetLabel} />
      </div>
      <div className="setting-row">
        <input
          id={inputId}
          type={secret ? 'password' : 'text'}
          autoComplete="off"
          spellCheck={false}
          list={listId}
          placeholder={secret && source ? '•••••••• (unchanged)' : placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button className="btn btn-primary" disabled={!dirty || pending}>
          Save
        </button>
        {source === 'settings' && (
          <button type="button" className="btn" disabled={pending} onClick={() => (onSave(null), setValue(''))}>
            Clear
          </button>
        )}
      </div>
      {hint && <p className="setting-hint">{hint}</p>}
    </form>
  );
}

export function SettingsPage() {
  const auth = useAuthStatus();
  const settings = useSettings();
  const update = useUpdateSettings();
  const signOut = useSignOut();
  const checkOpenRouter = useCheckConnection();
  const checkCrawl4ai = useCheckConnection();
  const checkSearxng = useCheckConnection();
  const batches = useBatches();
  const notebooks = useNotebooks();
  const allPages = usePages();
  const templates = (allPages.data ?? []).filter((p) => p.tags.includes(TEMPLATE_TAG));
  const undo = useUndoBatch();
  const models = useModels(true);
  const embeddingModels = useModels(true, 'embedding');
  const modelList = useId();
  const embeddingList = useId();
  const installPrompt = useInstallPrompt();

  if (!settings.data) return null;
  const { openrouter, crawl4ai, ai, daily, tasks, semantic, assistant } = settings.data;
  const save = (input: SettingsUpdate) => update.mutate(input);

  return (
    <div className="content settings">
      <header className="content-header">
        <h1>Settings</h1>
        <p className="muted">Stored per account. Keys and tokens are encrypted and never sent back to the browser.</p>
      </header>

      <section className="settings-card">
        <h2>
          <PlugZap size={18} /> OpenRouter
        </h2>
        <p className="muted">Used to turn imported pages into structured notes. Without a key, imports still work as plain page clips.</p>

        <SettingField
          key={`key-${openrouter.apiKeySource}`}
          label="API key"
          secret
          source={openrouter.apiKeySource}
          current={null}
          placeholder="sk-or-…"
          pending={update.isPending}
          onSave={(v) => save({ openrouterApiKey: v })}
          hint={
            <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">
              Create a key at openrouter.ai <ExternalLink size={12} />
            </a>
          }
        />
        <div className="setting-actions">
          <button className="btn" disabled={checkOpenRouter.isPending} onClick={() => checkOpenRouter.mutate('openrouter')}>
            {checkOpenRouter.isPending ? 'Testing…' : 'Test connection'}
          </button>
          <CheckResult result={checkOpenRouter.data} />
        </div>
      </section>

      <section className="settings-card models-card" id="models">
        <h2>
          <Cpu size={18} /> AI models
        </h2>
        <p className="muted">
          Each AI feature can use its own OpenRouter model; empty ones use the default model. Prices are per million
          tokens, input / output.
        </p>
        <SettingField
          key={`model-${openrouter.model}`}
          label="Default model"
          source={openrouter.modelSource}
          current={openrouter.model}
          placeholder={DEFAULT_OPENROUTER_MODEL}
          listId={modelList}
          pending={update.isPending}
          onSave={(v) => save({ openrouterModel: v })}
          hint={<ModelHint id={openrouter.model} models={models.data} text={`Clear to go back to ${DEFAULT_OPENROUTER_MODEL}.`} />}
        />
        {AI_TASKS.map((task) => {
          const own = settings.data!.models[task];
          return (
            <SettingField
              key={`${task}-${own.model}`}
              label={AI_TASK_INFO[task].label}
              source={own.source}
              current={own.model}
              placeholder={`Default · ${openrouter.model}`}
              unsetLabel="Uses default"
              listId={modelList}
              pending={update.isPending}
              onSave={(v) => save({ [modelSetting(task)]: v } as SettingsUpdate)}
              hint={<ModelHint id={own.model} models={models.data} text={AI_TASK_INFO[task].hint} />}
            />
          );
        })}
        <ModelList id={modelList} models={models.data} />
        {models.error && <p className="setting-hint">OpenRouter's model list is unavailable, so prices are not shown.</p>}
      </section>

      <section className="settings-card">
        <h2>
          <PlugZap size={18} /> crawl4ai
        </h2>
        <p className="muted">
          Optional. A self-hosted crawl4ai renders JavaScript-heavy pages before import. Without it, Nicotes fetches pages
          itself and extracts the main content with Readability.
        </p>
        <SettingField
          key={`url-${crawl4ai.url}`}
          label="URL"
          source={crawl4ai.urlSource}
          current={crawl4ai.url}
          placeholder="http://crawl4ai:11235"
          pending={update.isPending}
          onSave={(v) => save({ crawl4aiUrl: v })}
        />
        <SettingField
          key={`token-${crawl4ai.tokenSource}`}
          label="API token"
          secret
          source={crawl4ai.tokenSource}
          current={null}
          pending={update.isPending}
          onSave={(v) => save({ crawl4aiToken: v })}
          hint="The CRAWL4AI_API_TOKEN of your crawl4ai container (required since crawl4ai 0.9)."
        />
        <div className="setting-actions">
          <button className="btn" disabled={checkCrawl4ai.isPending} onClick={() => checkCrawl4ai.mutate('crawl4ai')}>
            {checkCrawl4ai.isPending ? 'Testing…' : 'Test connection'}
          </button>
          <CheckResult result={checkCrawl4ai.data} />
        </div>
      </section>

      <section className="settings-card">
        <h2>
          <Telescope size={18} /> Research &amp; AI
        </h2>
        <p className="muted">
          Research searches the web via SearXNG when configured, otherwise via OpenRouter's web search (about $0.01 per
          search). Every AI run stops once it reaches the cost limit.
        </p>
        <SettingField
          key={`sx-${ai.searxngUrl}`}
          label="SearXNG URL"
          source={ai.searxngUrlSource}
          current={ai.searxngUrl}
          placeholder="http://nas.local:8888"
          pending={update.isPending}
          onSave={(v) => save({ searxngUrl: v })}
          hint="Optional. The instance must allow the JSON format (search.formats: [html, json])."
        />
        <SettingField
          key={`cost-${ai.costLimit}`}
          label="Cost limit per run (USD)"
          source={ai.costLimitSource}
          current={String(ai.costLimit)}
          pending={update.isPending}
          onSave={(v) => save({ aiCostLimit: v === null ? null : Number(v.replace(',', '.')) })}
        />
        <label className="field">
          <span>The page assistant may read</span>
          <select value={assistant.scope} onChange={(e) => save({ assistantScope: e.target.value as ReadScope })}>
            {READ_SCOPES.map((s) => (
              <option key={s} value={s}>
                {READ_SCOPE_INFO[s].label}
              </option>
            ))}
          </select>
          <small className="muted">
            {READ_SCOPE_INFO[assistant.scope].hint} It only ever changes the open page, and only with your approval. Also
            switchable in the assistant panel.
          </small>
        </label>
        <div className="setting-actions">
          <button className="btn" disabled={checkSearxng.isPending} onClick={() => checkSearxng.mutate('searxng')}>
            {checkSearxng.isPending ? 'Testing…' : 'Test SearXNG'}
          </button>
          <CheckResult result={checkSearxng.data} />
        </div>
        {!!batches.data?.length && (
          <div className="setting">
            <span className="setting-label">Recent AI changes</span>
            <ul className="trash-list">
              {batches.data.slice(0, 8).map((b) => (
                <li key={b.id} className="trash-item">
                  <div className="trash-info">
                    <span className="trash-title">{b.summary}</span>
                    <span className="trash-meta">
                      {timeAgo(b.createdAt)}
                      {b.undoneAt && ` · undone ${timeAgo(b.undoneAt)}`}
                    </span>
                  </div>
                  {!b.undoneAt && (
                    <button className="btn btn-sm" disabled={undo.isPending} onClick={() => undo.mutate(b.id)}>
                      <RotateCcw size={14} /> Undo
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <SemanticCard
        semantic={semantic}
        apiKeySet={openrouter.apiKeySet}
        pending={update.isPending}
        save={save}
        models={embeddingModels.data}
        listId={embeddingList}
      />

      {update.error && <p className="error">{update.error.message}</p>}

      <section className="settings-card" id="daily">
        <h2>
          <CalendarDays size={18} /> Daily notes
        </h2>
        <p className="muted">
          “Today” opens the note for the current day, filed as notebook › year › month. Templates are pages tagged
          #template; they can use {'{{date}}'}, {'{{weekday}}'}, {'{{time}}'} and {'{{title}}'}.
        </p>
        <div className="import-target">
          <label className="field">
            <span>Notebook</span>
            <select value={daily.notebookId ?? ''} onChange={(e) => save({ dailyNotebookId: e.target.value || null })}>
              <option value="">“Journal” (created automatically)</option>
              {notebooks.data?.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.title}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Template</span>
            <select value={daily.templateId ?? ''} onChange={(e) => save({ dailyTemplateId: e.target.value || null })}>
              <option value="">Default (Notes + Tasks)</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {displayTitle(t.title)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section className="settings-card" id="tasks">
        <h2>
          <ListChecks size={18} /> Tasks
        </h2>
        <p className="muted">
          The task list collects every checkbox. Checklists that are not to-dos, like the ingredients of imported
          recipes, can be left out by tag (subpages of tags that apply to subpages count too).
        </p>
        <SettingField
          key={`tasks-${tasks.excludeTags.join(',')}`}
          label="Leave out pages tagged"
          source={tasks.excludeTagsSource}
          current={tasks.excludeTags.join(', ')}
          placeholder="nothing left out"
          pending={update.isPending}
          allowEmpty
          onSave={(v) => save({ tasksExcludeTags: v === null ? null : v.split(/[\s,]+/).filter(Boolean) })}
          hint="Comma-separated tags; save it empty to include everything. “Clear” goes back to the default (recipe)."
        />
      </section>

      <section className="settings-card">
        <h2>
          <FileDown size={18} /> Export
        </h2>
        <p className="muted">
          A zip of Markdown files, one folder per notebook, with tags and dates in each file's header and attachments
          included. It opens as an Obsidian vault. Single notebooks can be exported from their ⋯ menu.
        </p>
        <div className="setting-actions">
          <a className="btn" href={exportUrl()} download>
            <FileDown size={15} /> Download everything
          </a>
        </div>
      </section>

      <SettingsBackups />

      <section className="settings-card">
        <h2>
          <Smartphone size={18} /> App
        </h2>
        <p className="muted">
          Install Nicotes on your home screen or desktop. On Android, installed Nicotes appears in the share menu: sharing a
          link opens the importer. Installing needs HTTPS (or localhost).
        </p>
        <div className="setting-actions">
          {installPrompt.installed ? (
            <span className="check ok">
              <CheckCircle2 size={15} /> Running as an installed app
            </span>
          ) : installPrompt.available ? (
            <button className="btn btn-primary" onClick={() => void installPrompt.install()}>
              <Smartphone size={15} /> Install app
            </button>
          ) : (
            <span className="muted">
              Use your browser's menu (“Install app” / “Add to Home Screen”) to install. On iOS: Share → Add to Home Screen.
            </span>
          )}
        </div>
      </section>

      <section className="settings-card">
        <h2>Account</h2>
        <div className="setting-actions">
          <span>
            Signed in as <strong>{auth.data?.user?.username}</strong>
          </span>
          <button className="btn" onClick={() => signOut.mutate()}>
            <LogOut size={15} /> Sign out
          </button>
        </div>
      </section>

      <AboutCard />
    </div>
  );
}

/** Version, build and what the server runs on; "Copy details" for bug reports. */
function AboutCard() {
  const system = useSystemInfo();
  const [copied, setCopied] = useState(false);
  const s = system.data;
  if (!s) return null;

  // A release tag repeats the version; branches (develop, main) are worth showing.
  const ref = s.build.ref && s.build.ref !== `v${s.version}` ? s.build.ref : null;
  const built = s.build.date ? new Date(s.build.date).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : null;
  const rows: [string, string][] = [
    ['Version', [s.version, ref].filter(Boolean).join(' · ')],
    ['Build', s.build.commit ? [s.build.commit.slice(0, 8), built].filter(Boolean).join(' · ') : 'Local build'],
    ['Server', `Node ${s.server.node.replace(/^v/, '')} · ${s.server.os} (${s.server.arch})${s.server.docker ? ' · Docker' : ''}`],
    ['Running for', formatDuration(s.server.uptime)],
    ['Database', `SQLite ${s.database.sqlite} · ${formatSize(s.database.size)} · ${s.database.migrations} migrations`],
    [
      'Your data',
      `${s.data.notebooks} notebooks · ${s.data.pages} pages · ${s.data.attachments} attachments (${formatSize(s.data.attachmentBytes)}) · ` +
        `${s.data.versions} versions · ${s.data.trash} in the trash`,
    ],
    ['Data folder', s.dataDir],
  ];
  const copy = () => {
    void navigator.clipboard.writeText(`Nicotes\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}`).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <section className="settings-card" id="about">
      <h2>
        <Info size={18} /> About Nicotes
      </h2>
      <dl className="about-list">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <div className="setting-actions">
        <button className="btn btn-sm" onClick={copy}>
          {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy details'}
        </button>
      </div>
    </section>
  );
}

function SemanticCard({
  semantic,
  apiKeySet,
  pending,
  save,
  models,
  listId,
}: {
  semantic: Settings['semantic'];
  apiKeySet: boolean;
  pending: boolean;
  save: (input: SettingsUpdate) => void;
  models?: ModelInfo[];
  listId: string;
}) {
  const status = useSemanticStatus(semantic.enabled);
  const action = useSemanticAction();
  const s = semantic.enabled ? status.data : undefined;
  const percent = s?.pages ? Math.round((s.indexed / s.pages) * 100) : 0;

  return (
    <section className="settings-card" id="semantic">
      <h2>
        <Sparkles size={18} /> Semantic index
      </h2>
      <p className="muted">
        Finds notes by meaning: related pages under each page, “By meaning” results in search and “Ask your notes”.
        While it is on, the text of your notes is sent to OpenRouter to compute embeddings (with the default model
        about $0.02 per million words, a few cents for thousands of pages). Switching it off deletes the index.
      </p>
      <label className="check-row">
        <input
          type="checkbox"
          checked={semantic.enabled}
          disabled={pending || (!apiKeySet && !semantic.enabled)}
          onChange={(e) => save({ semanticIndex: e.target.checked })}
        />
        Index my notes
      </label>
      {!apiKeySet && <p className="setting-hint">Needs an OpenRouter API key (see above).</p>}
      {s && (
        <div className="semantic-status" role="status">
          <div className="semantic-bar" aria-hidden="true">
            <span style={{ width: `${percent}%` }} />
          </div>
          <span className="muted">
            {s.indexed} of {s.pages} pages indexed · {s.chunks} passages · {formatCost(s.cost)} so far
            {s.indexed < s.pages && !s.error && ' · indexing…'}
          </span>
          {s.error && (
            <p className="check fail">
              <XCircle size={15} /> {s.error}
              <button className="btn btn-sm" disabled={action.isPending} onClick={() => action.mutate('retry')}>
                Retry now
              </button>
            </p>
          )}
        </div>
      )}
      <SettingField
        key={`emb-${semantic.model}`}
        label="Embedding model"
        source={semantic.modelSource}
        current={semantic.model}
        listId={listId}
        pending={pending}
        onSave={(v) => save({ embeddingModel: v })}
        hint={
          <ModelHint
            id={semantic.model}
            models={models}
            text="Changing it rebuilds the index. Multilingual models match notes across languages."
          />
        }
      />
      <ModelList id={listId} models={models} />
      {semantic.enabled && (
        <div className="setting-actions">
          <button className="btn" disabled={action.isPending} onClick={() => action.mutate('rebuild')}>
            <RotateCcw size={14} /> Rebuild index
          </button>
        </div>
      )}
    </section>
  );
}

// OpenRouter's prices carry float noise (0.09999…): cents above ~$0.10, two significant digits below.
const price = (usd: number) => `$${usd >= 0.095 ? usd.toFixed(2) : String(Number(usd.toPrecision(2)))}`;

/** A model's price per million tokens, or a warning when OpenRouter does not list it. */
function ModelHint({ id, models, text }: { id: string | null; models?: ModelInfo[]; text: string }) {
  const info = id ? models?.find((m) => m.id === id) : undefined;
  return (
    <>
      {text}
      {info && info.promptPrice !== null && (
        <span className="model-price">
          {' '}
          · {price(info.promptPrice)}
          {info.completionPrice !== null && ` / ${price(info.completionPrice)}`}
        </span>
      )}
      {id && models && !info && <span className="model-unknown"> · Not in OpenRouter's model list — check the id.</span>}
    </>
  );
}

function ModelList({ id, models }: { id: string; models?: ModelInfo[] }) {
  return (
    <datalist id={id}>
      {models?.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name}
          {m.promptPrice !== null ? ` · ${price(m.promptPrice)}/M in` : ''}
        </option>
      ))}
    </datalist>
  );
}
