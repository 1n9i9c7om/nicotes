import { and, desc, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Job, JobKind, JobProgress, JobStatus } from '@nicotes/shared';
import type { AppEnv } from '../auth.js';
import type { Db } from '../db/index.js';
import { jobs } from '../db/schema.js';
import { notFound } from '../http.js';
import { newId } from '../ids.js';
import type { AiConfig, SettingsStore } from '../settings.js';
import { hasKeyFor, LlmError, missingKeyMessage, type Usage } from './llm.js';

export class JobCancelled extends Error {}

export interface JobContext<I> {
  jobId: string;
  userId: string;
  input: I;
  cfg: AiConfig;
  signal: AbortSignal;
  /** Updates the progress line (and appends it to the log). */
  step: (message: string, done?: number, total?: number) => void;
  /** Adds OpenRouter spend; throws once the job's cost limit is exceeded. */
  charge: (usage: Usage) => void;
  /** Throws if the job was cancelled. */
  check: () => void;
}

export type JobHandler<I = unknown, R = unknown> = (ctx: JobContext<I>) => Promise<R>;

const MAX_PARALLEL = 2;
const LOG_LINES = 30;

function toJob(row: typeof jobs.$inferSelect): Job {
  return {
    id: row.id,
    kind: row.kind as JobKind,
    status: row.status as JobStatus,
    input: JSON.parse(row.input),
    progress: JSON.parse(row.progress) as JobProgress,
    result: row.result ? JSON.parse(row.result) : null,
    error: row.error,
    cost: row.cost,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Runs AI jobs in-process, a few at a time, persisting status and progress. */
export class JobRunner {
  private handlers = new Map<JobKind, JobHandler>();
  private queue: string[] = [];
  private running = new Map<string, AbortController>();

  constructor(
    private db: Db,
    private settings: SettingsStore,
  ) {
    // Jobs cannot survive a restart; don't leave them spinning forever.
    db.update(jobs)
      .set({ status: 'failed', error: 'Interrupted by a server restart', updatedAt: Date.now() })
      .where(inArray(jobs.status, ['queued', 'running']))
      .run();
  }

  register<I, R>(kind: JobKind, handler: JobHandler<I, R>) {
    this.handlers.set(kind, handler as JobHandler);
  }

  start(userId: string, kind: JobKind, input: unknown): Job {
    const now = Date.now();
    const row = {
      id: newId(),
      userId,
      kind,
      status: 'queued',
      input: JSON.stringify(input),
      progress: JSON.stringify({ message: 'Waiting to start…' }),
      cost: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(jobs).values(row).run();
    this.queue.push(row.id);
    queueMicrotask(() => this.pump());
    return this.get(userId, row.id);
  }

  get(userId: string, id: string): Job {
    const row = this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, id), eq(jobs.userId, userId)))
      .get();
    if (!row) throw notFound('Job');
    return toJob(row);
  }

  list(userId: string, kind?: JobKind, limit = 20): Job[] {
    return this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.userId, userId), kind ? eq(jobs.kind, kind) : undefined))
      .orderBy(desc(jobs.createdAt))
      .limit(limit)
      .all()
      .map(toJob);
  }

  cancel(userId: string, id: string): Job {
    const job = this.get(userId, id);
    if (job.status === 'queued') {
      this.queue = this.queue.filter((q) => q !== id);
      this.finish(id, 'cancelled', { error: 'Cancelled' });
    }
    this.running.get(id)?.abort();
    return this.get(userId, id);
  }

  /**
   * Removes a finished job from the history. What it made stays (a research note is an
   * ordinary page); applied organize batches keep their undo, without the job link.
   */
  remove(userId: string, id: string) {
    const job = this.get(userId, id);
    if (job.status === 'queued' || job.status === 'running') throw new HTTPException(409, { message: 'Cancel the run first' });
    this.db.delete(jobs).where(eq(jobs.id, id)).run();
  }

  /** Stores a changed result (e.g. after suggestions were applied). */
  updateResult(id: string, result: unknown) {
    this.db.update(jobs).set({ result: JSON.stringify(result), updatedAt: Date.now() }).where(eq(jobs.id, id)).run();
  }

  /** Resolves when no job is queued or running (for tests). */
  async idle() {
    while (this.queue.length || this.running.size) await new Promise((r) => setTimeout(r, 10));
  }

  private finish(id: string, status: JobStatus, fields: { result?: unknown; error?: string }) {
    this.db
      .update(jobs)
      .set({
        status,
        result: fields.result === undefined ? undefined : JSON.stringify(fields.result),
        error: fields.error ?? null,
        updatedAt: Date.now(),
      })
      .where(eq(jobs.id, id))
      .run();
  }

  private pump() {
    while (this.running.size < MAX_PARALLEL && this.queue.length) {
      const id = this.queue.shift()!;
      void this.run(id);
    }
  }

  private async run(id: string) {
    const row = this.db.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!row || row.status !== 'queued') return;
    const handler = this.handlers.get(row.kind as JobKind);
    const controller = new AbortController();
    this.running.set(id, controller);

    const progress: JobProgress = { log: [] };
    let cost = 0;
    const cfg = this.settings.effective(row.userId);
    const save = () =>
      this.db
        .update(jobs)
        .set({ progress: JSON.stringify(progress), cost, updatedAt: Date.now() })
        .where(eq(jobs.id, id))
        .run();
    const check = () => {
      if (controller.signal.aborted) throw new JobCancelled('Cancelled');
    };

    const ctx: JobContext<unknown> = {
      jobId: id,
      userId: row.userId,
      input: JSON.parse(row.input),
      cfg,
      signal: controller.signal,
      check,
      step: (message, done, total) => {
        check();
        progress.message = message;
        progress.done = done;
        progress.total = total;
        progress.log = [...(progress.log ?? []), message].slice(-LOG_LINES);
        save();
      },
      charge: (usage) => {
        cost += usage.cost;
        save();
        if (cost > cfg.costLimit) {
          throw new LlmError(`Stopped at the cost limit of $${cfg.costLimit.toFixed(2)} (Settings → AI)`);
        }
      },
    };

    this.db.update(jobs).set({ status: 'running', updatedAt: Date.now() }).where(eq(jobs.id, id)).run();
    try {
      if (!handler) throw new Error(`No handler for ${row.kind}`);
      const model = cfg.models[row.kind as JobKind];
      if (!hasKeyFor(cfg.keys, model)) throw new LlmError(missingKeyMessage('This', model));
      const result = await handler(ctx);
      this.finish(id, 'done', { result });
    } catch (error) {
      const cancelled = controller.signal.aborted || error instanceof JobCancelled;
      if (!cancelled && !(error instanceof LlmError)) console.error(`Job ${id} failed`, error);
      this.finish(id, cancelled ? 'cancelled' : 'failed', {
        error: cancelled ? 'Cancelled' : (error as Error).message,
      });
    } finally {
      this.running.delete(id);
      this.pump();
    }
  }
}

export function jobRoutes(runner: JobRunner) {
  return new Hono<AppEnv>()
    .get('/', (c) => c.json(runner.list(c.var.user.id, (c.req.query('kind') as JobKind) || undefined)))
    .get('/:id', (c) => c.json(runner.get(c.var.user.id, c.req.param('id'))))
    .post('/:id/cancel', (c) => c.json(runner.cancel(c.var.user.id, c.req.param('id'))))
    .delete('/:id', (c) => {
      runner.remove(c.var.user.id, c.req.param('id'));
      return c.body(null, 204);
    });
}

/** Runs `fn` over `items` with at most `limit` in flight, keeping result order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
