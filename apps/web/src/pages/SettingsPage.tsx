import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { CalendarDays, Check, CheckCircle2, Copy, Cpu, Info, ListChecks, Sparkles, ExternalLink, FileDown, LogOut, PlugZap, RotateCcw, Server, Smartphone, Telescope, XCircle } from 'lucide-react';
import { TEMPLATE_TAG } from '@nicotes/shared';
import { displayTitle } from '../lib/tree';
import { formatDuration, formatSize, timeAgo } from '../lib/format';
import {
  AI_TASK_INFO,
  AI_TASKS,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_OPENROUTER_MODEL,
  modelSetting,
  providerOf,
  type ConnectionCheck,
  type ModelInfo,
  type Settings,
  type SettingSource,
  type SettingsUpdate,
} from '@nicotes/shared';
import { formatCost } from '../components/JobProgress';
import { ModelPicker } from '../components/ModelPicker';
import { SettingsBackups } from '../components/SettingsBackups';
import { SettingsSecurity } from '../components/SettingsSecurity';
import { SettingsShares } from '../components/SettingsShares';
import { SettingsTokens } from '../components/SettingsTokens';
import { SettingsCalendar } from '../components/SettingsCalendar';
import {
  exportUrl,
  useAuthStatus,
  useBatches,
  useCheckConnection,
  useModels,
  useRefreshModels,
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
import { serviceReady } from '../lib/ai';

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

/** A model setting: the picker saves right away; "Clear" goes back to the environment/default. */
function ModelField({
  label,
  hint,
  source,
  value,
  placeholder,
  unsetLabel,
  allowDefault,
  filters,
  list,
  kind,
  pending,
  onSave,
}: {
  label: string;
  hint?: ReactNode;
  source: SettingSource;
  value: string | null;
  placeholder: string;
  unsetLabel?: string;
  allowDefault?: boolean;
  filters?: boolean;
  list: ReturnType<typeof useModels>;
  kind: 'chat' | 'embedding';
  pending: boolean;
  onSave: (value: string | null) => void;
}) {
  const inputId = useId();
  const refresh = useRefreshModels(kind);
  return (
    <div className="setting">
      <div className="setting-head">
        <label className="setting-label" htmlFor={inputId}>
          {label}
        </label>
        <Source source={source} unset={unsetLabel} />
      </div>
      <div className="setting-row">
        <ModelPicker
          id={inputId}
          label={label}
          value={value}
          placeholder={placeholder}
          models={list.data?.models}
          loading={list.isPending}
          allowDefault={allowDefault}
          filters={filters}
          disabled={pending}
          onChange={(id) => id !== value && onSave(id)}
          onRefresh={() => refresh.mutate()}
          refreshing={refresh.isPending}
        />
        {source === 'settings' && (
          <button type="button" className="btn" disabled={pending} onClick={() => onSave(null)}>
            Clear
          </button>
        )}
      </div>
      {hint && <p className="setting-hint">{hint}</p>}
    </div>
  );
}

export function SettingsPage() {
  const auth = useAuthStatus();
  const settings = useSettings();
  const update = useUpdateSettings();
  const signOut = useSignOut();
  const checkOpenRouter = useCheckConnection();
  const checkRouteway = useCheckConnection();
  const checkLocal = useCheckConnection();
  const checkCrawl4ai = useCheckConnection();
  const checkSearxng = useCheckConnection();
  const batches = useBatches();
  const notebooks = useNotebooks();
  const allPages = usePages();
  const templates = (allPages.data ?? []).filter((p) => p.tags.includes(TEMPLATE_TAG));
  const undo = useUndoBatch();
  const models = useModels(true);
  const embeddingModels = useModels(true, 'embedding');
  const installPrompt = useInstallPrompt();

  if (!settings.data) return null;
  const { openrouter, routeway, local, crawl4ai, ai, daily, tasks, semantic } = settings.data;
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
        <p className="muted">
          Runs the AI features with OpenRouter's models and computes the embeddings for the semantic index. Without any
          AI key, imports still work as plain page clips.
        </p>

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

      <section className="settings-card" id="routeway">
        <h2>
          <PlugZap size={18} /> Routeway
        </h2>
        <p className="muted">
          Optional second service: an OpenAI-compatible gateway with its own models and prices. Its models appear in the
          model pickers below, marked Routeway; each feature uses the service of the model you pick for it.
        </p>
        <SettingField
          key={`rw-key-${routeway.apiKeySource}`}
          label="API key"
          secret
          source={routeway.apiKeySource}
          current={null}
          placeholder="sk-…"
          pending={update.isPending}
          onSave={(v) => save({ routewayApiKey: v })}
          hint={
            <a href="https://routeway.ai" target="_blank" rel="noreferrer">
              Create a key at routeway.ai <ExternalLink size={12} />
            </a>
          }
        />
        <div className="setting-actions">
          <button className="btn" disabled={checkRouteway.isPending} onClick={() => checkRouteway.mutate('routeway')}>
            {checkRouteway.isPending ? 'Testing…' : 'Test connection'}
          </button>
          <CheckResult result={checkRouteway.data} />
        </div>
      </section>

      <section className="settings-card" id="local-models">
        <h2>
          <Server size={18} /> Your own model server
        </h2>
        <p className="muted">
          Runs AI features on a server you control, so your notes don't leave your network: Ollama, LM Studio,
          LocalAI, vLLM or anything else with an OpenAI-compatible API. Its models appear in the model pickers below,
          marked Own server, and cost nothing. They can't search the web; research then needs SearXNG or uses the
          model's own knowledge.
        </p>
        <SettingField
          key={`local-url-${local.urlSource}-${local.url}`}
          label="Address"
          source={local.urlSource}
          current={local.url}
          placeholder="http://ollama:11434/v1"
          pending={update.isPending}
          onSave={(v) => save({ localAiUrl: v })}
          hint="The address of its OpenAI API, usually ending in /v1. Ollama: http://<host>:11434/v1, LM Studio: http://<host>:1234/v1."
        />
        <SettingField
          key={`local-key-${local.apiKeySource}`}
          label="API key (optional)"
          secret
          source={local.apiKeySource}
          current={null}
          unsetLabel="None"
          pending={update.isPending}
          onSave={(v) => save({ localAiKey: v })}
          hint="Only if your server asks for one."
        />
        <div className="setting-actions">
          <button className="btn" disabled={checkLocal.isPending} onClick={() => checkLocal.mutate('local')}>
            {checkLocal.isPending ? 'Testing…' : 'Test connection'}
          </button>
          <CheckResult result={checkLocal.data} />
        </div>
      </section>

      <section className="settings-card models-card" id="models">
        <h2>
          <Cpu size={18} /> AI models
        </h2>
        <p className="muted">
          Each AI feature can use its own model from OpenRouter, Routeway or your own server; unset ones use the
          default model. Prices are per million tokens, input / output.
        </p>
        <ModelField
          label="Default model"
          source={openrouter.modelSource}
          value={openrouter.model}
          placeholder={DEFAULT_OPENROUTER_MODEL}
          list={models}
          kind="chat"
          pending={update.isPending}
          onSave={(v) => save({ openrouterModel: v })}
          hint={<ModelHint id={openrouter.model} models={models.data?.models} text={`Clear to go back to ${DEFAULT_OPENROUTER_MODEL}.`} />}
        />
        {AI_TASKS.map((task) => {
          const own = settings.data!.models[task];
          return (
            <ModelField
              key={task}
              label={AI_TASK_INFO[task].label}
              source={own.source}
              value={own.model}
              placeholder={`Default · ${models.data?.models.find((m) => m.id === openrouter.model)?.name ?? openrouter.model}`}
              unsetLabel="Uses default"
              allowDefault
              list={models}
              kind="chat"
              pending={update.isPending}
              onSave={(v) => save({ [modelSetting(task)]: v } as SettingsUpdate)}
              hint={<ModelHint id={own.model} models={models.data?.models} text={AI_TASK_INFO[task].hint} />}
            />
          );
        })}
        {models.error && <p className="setting-hint">The model lists are unavailable, so models and prices are not shown.</p>}
        {models.data?.errors.map((e) => (
          <p key={e} className="setting-hint">
            {e} — its models are missing from the lists.
          </p>
        ))}
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
          Research searches the web via SearXNG when configured, otherwise via the web search of the research model's
          service (OpenRouter's web plugin, about $0.01 per search, or Routeway's “@online”). Every AI run stops once it reaches the cost limit.
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
        ready={serviceReady(settings.data, semantic.model)}
        pending={update.isPending}
        save={save}
        list={embeddingModels}
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
        <SettingsCalendar />
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

      <SettingsShares />

      <SettingsTokens />

      <SettingsSecurity />

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
  ready,
  pending,
  save,
  list,
}: {
  semantic: Settings['semantic'];
  /** Whether the service that runs the embedding model is set up. */
  ready: boolean;
  pending: boolean;
  save: (input: SettingsUpdate) => void;
  list: ReturnType<typeof useModels>;
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
        While it is on, the text of your notes is sent to the service of the embedding model to compute embeddings:
        OpenRouter (with the default model about $0.02 per million words, a few cents for thousands of pages), or your
        own server for free. Switching it off deletes the index.
      </p>
      <label className="check-row">
        <input
          type="checkbox"
          checked={semantic.enabled}
          disabled={pending || (!ready && !semantic.enabled)}
          onChange={(e) => save({ semanticIndex: e.target.checked })}
        />
        Index my notes
      </label>
      {!ready && (
        <p className="setting-hint">
          {providerOf(semantic.model) === 'local'
            ? 'Needs the address of your own model server (see above).'
            : 'Needs an OpenRouter API key (see above), or an embedding model from your own server.'}
        </p>
      )}
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
      <ModelField
        label="Embedding model"
        source={semantic.modelSource}
        value={semantic.model}
        placeholder={DEFAULT_EMBEDDING_MODEL}
        filters={false}
        list={list}
        kind="embedding"
        pending={pending}
        onSave={(v) => save({ embeddingModel: v })}
        hint={
          <ModelHint
            id={semantic.model}
            models={list.data?.models}
            text="From OpenRouter or your own server. Changing it rebuilds the index. Multilingual models match notes across languages."
          />
        }
      />
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
      {id && models && !info && <span className="model-unknown"> · Not in the model lists — check the id.</span>}
    </>
  );
}
