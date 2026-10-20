import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { CheckCircle2, ExternalLink, FileDown, LogOut, PlugZap, Smartphone, XCircle } from 'lucide-react';
import { DEFAULT_OPENROUTER_MODEL, type ConnectionCheck, type SettingSource, type SettingsUpdate } from '@nicotes/shared';
import {
  exportUrl,
  useAuthStatus,
  useCheckConnection,
  useModels,
  useSettings,
  useSignOut,
  useUpdateSettings,
} from '../lib/queries';
import { useInstallPrompt } from '../lib/install';

const SOURCE_LABEL: Record<Exclude<SettingSource, null>, string> = {
  settings: 'Saved here',
  env: 'From environment variable',
  default: 'Default',
};

function Source({ source }: { source: SettingSource }) {
  return <span className={`source source-${source ?? 'none'}`}>{source ? SOURCE_LABEL[source] : 'Not set'}</span>;
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
  onSave: (value: string | null) => void;
  pending: boolean;
}) {
  const [value, setValue] = useState(secret ? '' : (current ?? ''));
  const dirty = secret ? value !== '' : value !== (current ?? '');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSave(value.trim() || null);
    if (secret) setValue('');
  };

  return (
    <form className="setting" onSubmit={submit}>
      <div className="setting-head">
        <label className="setting-label">{label}</label>
        <Source source={source} />
      </div>
      <div className="setting-row">
        <input
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
  const [loadModels, setLoadModels] = useState(false);
  const models = useModels(loadModels);
  const modelList = useId();
  const installPrompt = useInstallPrompt();

  if (!settings.data) return null;
  const { openrouter, crawl4ai } = settings.data;
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
        <div onFocusCapture={() => setLoadModels(true)}>
          <SettingField
            key={`model-${openrouter.model}`}
            label="Model"
            source={openrouter.modelSource}
            current={openrouter.model}
            placeholder={DEFAULT_OPENROUTER_MODEL}
            listId={modelList}
            pending={update.isPending}
            onSave={(v) => save({ openrouterModel: v })}
            hint={`Any OpenRouter model id. Default: ${DEFAULT_OPENROUTER_MODEL}`}
          />
          <datalist id={modelList}>
            {models.data?.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.promptPrice !== null ? ` · $${m.promptPrice.toFixed(2)}/M in` : ''}
              </option>
            ))}
          </datalist>
        </div>
        <div className="setting-actions">
          <button className="btn" disabled={checkOpenRouter.isPending} onClick={() => checkOpenRouter.mutate('openrouter')}>
            {checkOpenRouter.isPending ? 'Testing…' : 'Test connection'}
          </button>
          <CheckResult result={checkOpenRouter.data} />
        </div>
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

      {update.error && <p className="error">{update.error.message}</p>}

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
    </div>
  );
}
