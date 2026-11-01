import { ADAPTER_TYPE_INFO, type Adapter, type AdapterRun, type AdapterSave, type AdapterType, type AdapterValue } from '@nicotes/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import type { Db } from '../db/index.js';
import { adapters, notebooks } from '../db/schema.js';
import { newId } from '../ids.js';
import { ensureDailyNote } from '../routes/daily.js';
import { createPage, findPage } from '../routes/pages.js';
import { saveContent } from '../routes/tasks.js';
import type { SecretBox } from '../secrets.js';
import type { SettingsStore } from '../settings.js';
import { localTime, timeZoneOf } from '../time.js';
import { homeAssistant } from './homeAssistant.js';
import { AdapterError, listValues, type Source } from './sources.js';
import { weather } from './weather.js';
import { setJournalLine, upsertLogbookRow } from './writers.js';

export interface AdapterOptions {
  /** Tests: fakes for the services adapters read from, and the clock. */
  fetch?: typeof fetch;
  now?: () => number;
}

const SOURCES: Record<AdapterType, Source> = { 'home-assistant': homeAssistant, weather };

const MINUTE = 60_000;
/** After a failed scheduled run, wait this long before the next try. */
const RETRY = 15 * MINUTE;
const MAX_ADAPTERS = 50;

type Row = typeof adapters.$inferSelect;

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const bad = (message: string) => new HTTPException(400, { message });

/**
 * Adapters read from other services once a day (at their time, in the account's time zone)
 * and on demand, writing a row into a logbook page or a line into the day's journal note.
 * Checks once a minute; `last_run_date` makes each day's scheduled run happen once.
 */
export class AdapterService {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private fetch: typeof fetch;
  private now: () => number;

  constructor(
    private db: Db,
    private settings: SettingsStore,
    private box: SecretBox,
    options: AdapterOptions = {},
  ) {
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  start() {
    this.timer = setInterval(() => void this.tick(), MINUTE);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  list(userId: string): Adapter[] {
    return this.db.select().from(adapters).where(eq(adapters.userId, userId)).orderBy(adapters.createdAt).all().map((r) => this.view(r));
  }

  get(userId: string, id: string): Adapter {
    return this.view(this.row(userId, id));
  }

  save(userId: string, input: AdapterSave & { type: AdapterType }, id?: string): Adapter {
    const existing = id ? this.row(userId, id) : null;
    if (existing && existing.type !== input.type) throw bad('An adapter cannot change its type');
    if (!existing && this.list(userId).length >= MAX_ADAPTERS) throw bad(`At most ${MAX_ADAPTERS} adapters`);
    const info = ADAPTER_TYPE_INFO[input.type];
    const before = existing ? this.secretsOf(existing) : {};
    const oldConfig: Record<string, string> = existing ? JSON.parse(existing.config) : {};
    const config: Record<string, string> = {};
    const secrets = { ...before };
    let addressChanged = false;
    for (const field of info.fields) {
      if (field.kind === 'secret') {
        const value = input.secrets?.[field.key];
        if (value === null) delete secrets[field.key];
        else if (value?.trim()) secrets[field.key] = value.trim();
        if (field.required && !secrets[field.key]) throw bad(`${field.label} is missing`);
        continue;
      }
      const value = (input.config?.[field.key] ?? '').trim();
      if (field.required && !value) throw bad(`${field.label} is missing`);
      if (value && field.kind === 'url' && !/^https?:\/\/[^\s/]+/i.test(value)) throw bad(`${field.label} must start with http:// or https://`);
      if (field.kind === 'url' && existing && value !== (oldConfig[field.key] ?? '')) addressChanged = true;
      if (value) config[field.key] = value;
    }
    // A stored token only goes to the address it was entered for.
    const kept = info.fields.filter((f) => f.kind === 'secret' && before[f.key] && secrets[f.key] === before[f.key] && !input.secrets?.[f.key]);
    if (addressChanged && kept.length) throw bad(`Enter the ${kept[0]!.label.toLowerCase()} again for the new address`);
    const problem = SOURCES[input.type].check?.(config);
    if (problem) throw bad(problem);

    const values = {
      name: input.name.trim(),
      config: JSON.stringify(config),
      secrets: Object.keys(secrets).length ? this.box.encrypt(JSON.stringify(secrets)) : null,
      target: input.target,
      dailyAt: input.dailyAt,
      enabled: input.enabled ?? true,
    };
    if (existing) {
      // A new time or target counts as not run yet today.
      const rescheduled = existing.dailyAt !== values.dailyAt || existing.target !== values.target;
      this.db
        .update(adapters)
        .set({ ...values, ...(rescheduled ? { lastRunDate: null } : {}) })
        .where(eq(adapters.id, existing.id))
        .run();
      return this.get(userId, existing.id);
    }
    const row = { id: newId(), userId, type: input.type, ...values, createdAt: this.now() };
    // Today counts as done when its time has passed already, so a new adapter does not run at once
    // (Run now does that); the first scheduled run is at the next time.
    const today = localTime(this.now(), timeZoneOf(this.settings, userId));
    const lastRunDate = minutes(today.time) >= minutes(values.dailyAt) ? today.date : null;
    this.db.insert(adapters).values({ ...row, lastRunDate }).run();
    return this.get(userId, row.id);
  }

  remove(userId: string, id: string) {
    this.row(userId, id);
    this.db.delete(adapters).where(eq(adapters.id, id)).run();
  }

  /** Reads today's values and writes them; failures are recorded on the adapter and thrown. */
  async run(userId: string, id: string, scheduled = false): Promise<AdapterRun> {
    const row = this.row(userId, id);
    const timeZone = timeZoneOf(this.settings, userId);
    const now = this.now();
    const { date } = localTime(now, timeZone);
    const config: Record<string, string> = JSON.parse(row.config);
    try {
      const result = await SOURCES[row.type as AdapterType].read({ config, secrets: this.secretsOf(row), date, timeZone, now, fetch: this.fetch });
      if (!result.values.some((v) => v.value !== null)) throw new AdapterError('No values were read');
      const pageId = row.target === 'journal' ? this.writeJournal(row, date, result.summary ?? listValues(result.values)) : this.writeLogbook(row, date, result.values);
      const message = `${date}: ${result.summary ?? listValues(result.values)}`;
      this.db
        .update(adapters)
        .set({
          lastRunAt: now,
          lastStatus: 'ok',
          lastMessage: message.slice(0, 1000),
          ...(row.target === 'logbook' ? { pageId } : {}),
          ...(scheduled ? { lastRunDate: date } : {}),
        })
        .where(eq(adapters.id, row.id))
        .run();
      return { date, values: result.values, pageId, message };
    } catch (err) {
      const message = err instanceof AdapterError ? err.message : err instanceof HTTPException ? err.message : `Failed: ${(err as Error).message}`;
      if (!(err instanceof AdapterError)) console.error(`Adapter ${row.id} failed:`, err);
      this.db.update(adapters).set({ lastRunAt: now, lastStatus: 'error', lastMessage: message.slice(0, 1000) }).where(eq(adapters.id, row.id)).run();
      throw new HTTPException(502, { message });
    }
  }

  /** Runs the adapters whose time has come today and that have not run today yet. */
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const rows = this.db.select().from(adapters).where(eq(adapters.enabled, true)).all();
      const zones = new Map<string, string>();
      for (const row of rows) {
        const zone = zones.get(row.userId) ?? timeZoneOf(this.settings, row.userId);
        zones.set(row.userId, zone);
        const today = localTime(this.now(), zone);
        if (row.lastRunDate === today.date || minutes(today.time) < minutes(row.dailyAt)) continue;
        if (row.lastStatus === 'error' && row.lastRunAt && this.now() - row.lastRunAt < RETRY) continue;
        await this.run(row.userId, row.id, true).catch(() => undefined);
      }
    } finally {
      this.ticking = false;
    }
  }

  private row(userId: string, id: string): Row {
    const row = this.db
      .select()
      .from(adapters)
      .where(and(eq(adapters.id, id), eq(adapters.userId, userId)))
      .get();
    if (!row) throw new HTTPException(404, { message: 'Adapter not found' });
    return row;
  }

  private secretsOf(row: Row): Record<string, string> {
    if (!row.secrets) return {};
    const plain = this.box.decrypt(row.secrets);
    return plain ? JSON.parse(plain) : {};
  }

  private view(row: Row): Adapter {
    return {
      id: row.id,
      type: row.type as AdapterType,
      name: row.name,
      config: JSON.parse(row.config),
      secretsSet: Object.keys(this.secretsOf(row)),
      target: row.target as Adapter['target'],
      dailyAt: row.dailyAt,
      enabled: row.enabled,
      pageId: row.pageId,
      lastRunAt: row.lastRunAt,
      lastStatus: row.lastStatus as Adapter['lastStatus'],
      lastMessage: row.lastMessage,
    };
  }

  private writeJournal(row: Row, date: string, text: string): string {
    const { pageId } = ensureDailyNote(this.db, this.settings, row.userId, date);
    this.db.transaction((tx) => {
      const page = findPage(tx, row.userId, pageId);
      const content = setJournalLine(page.content, row.name, text);
      if (content !== page.content) saveContent(tx, row.userId, page, content);
    });
    return pageId;
  }

  /** The adapter's page in the "Logbooks" notebook, made on the first run (again if deleted). */
  private writeLogbook(row: Row, date: string, values: AdapterValue[]): string {
    let pageId = row.pageId;
    if (pageId) {
      try {
        findPage(this.db, row.userId, pageId);
      } catch {
        pageId = null;
      }
    }
    if (!pageId) {
      const intro = `Filled in by the adapter “${row.name}” (${ADAPTER_TYPE_INFO[row.type as AdapterType].label}) every day; see Settings → Adapters.`;
      pageId = createPage(this.db, row.userId, { notebookId: this.logbooks(row.userId), title: row.name, content: `${intro}\n` }).id;
    }
    const id = pageId;
    this.db.transaction((tx) => {
      const page = findPage(tx, row.userId, id);
      const content = upsertLogbookRow(page.content, date, values);
      if (content !== page.content) saveContent(tx, row.userId, page, content);
    });
    return id;
  }

  private logbooks(userId: string): string {
    const existing = this.db
      .select({ id: notebooks.id })
      .from(notebooks)
      .where(and(eq(notebooks.userId, userId), eq(notebooks.title, 'Logbooks'), isNull(notebooks.deletedAt)))
      .get();
    if (existing) return existing.id;
    const id = newId();
    const now = Date.now();
    this.db.insert(notebooks).values({ id, userId, title: 'Logbooks', sortOrder: 9998, createdAt: now, updatedAt: now }).run();
    return id;
  }
}
