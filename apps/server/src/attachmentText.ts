import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, count, eq, isNull, ne, sql } from 'drizzle-orm';
import { getDocumentProxy } from 'unpdf';
import type { AttachmentSearchStatus } from '@nicotes/shared';
import { chat, hasKeyFor, missingKeyMessage } from './ai/llm.js';
import type { Db } from './db/index.js';
import { attachments, attachmentText } from './db/schema.js';
import type { AiConfig, SettingsStore } from './settings.js';

/** Characters kept per attachment, PDF pages read, and images sent to the model at most. */
const MAX_TEXT = 500_000;
const MAX_PDF_PAGES = 500;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const READ_TIMEOUT_MS = 120_000;

const TEXT_TYPES = /^(text\/|application\/(json|xml)$)/;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** Writes down an image's text (or what it shows); tests replace the model call. */
export type ImageReader = (cfg: AiConfig, mime: string, bytes: Buffer) => Promise<string>;

const PROMPT =
  'Write down all the text in this image, in reading order, as plain text in its original language. ' +
  'If there is no text, describe in one sentence what the image shows. Reply with nothing else.';

const aiImageReader: ImageReader = async (cfg, mime, bytes) => {
  const { content } = await chat({
    keys: cfg.keys,
    model: cfg.models.images,
    maxTokens: 2000,
    effort: 'minimal',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${bytes.toString('base64')}` } },
        ],
      },
    ],
  });
  return content.trim();
};

/** The text of a PDF's pages, line breaks kept; scanned PDFs (only images) have none. */
export async function pdfText(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(bytes);
  try {
    let text = '';
    for (let i = 1; i <= Math.min(pdf.numPages, MAX_PDF_PAGES) && text.length < MAX_TEXT; i++) {
      const content = await (await pdf.getPage(i)).getTextContent();
      for (const item of content.items) if ('str' in item) text += item.str + (item.hasEOL ? '\n' : '');
      text += '\n\n';
    }
    return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_TEXT);
  } finally {
    // Ends the document's worker side too, so many PDFs in a row do not pile up memory.
    await pdf.loadingTask.destroy();
  }
}

type Result = { status: 'done' | 'skipped' | 'error'; source: 'pdf' | 'text' | 'image' | null; text: string; error: string | null };

const withTimeout = <T>(work: Promise<T>, ms: number) =>
  Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Reading took too long')), ms).unref())]);

/**
 * Makes attachments searchable: reads the text of PDFs and text files, and, when turned on,
 * has an AI model read images. Works through attachments without a row in
 * `attachment_text` one at a time, in the background; triggers copy the text into the
 * full-text index.
 */
export class AttachmentReader {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private again = false;

  constructor(
    private db: Db,
    private dataDir: string,
    private settings: SettingsStore,
    private readImage: ImageReader = aiImageReader,
  ) {
    settings.onUpdate((userId, input) => {
      const affectsImages = [input.readImages, input.imagesModel, input.openrouterModel, input.openrouterApiKey, input.routewayApiKey, input.localAiUrl, input.localAiKey];
      if (affectsImages.some((v) => v !== undefined)) this.retryImages(userId);
    });
  }

  start() {
    void this.poke();
    // Also catches files stored without telling the reader (imports, backups restored).
    this.timer = setInterval(() => void this.poke(), 60_000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Reads every attachment not looked at yet; resolves when there are none left. */
  poke(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.drain();
      } while (this.again);
    })().finally(() => (this.running = null));
    return this.running;
  }

  private async drain() {
    for (;;) {
      const batch = this.db
        .select({ id: attachments.id })
        .from(attachments)
        .leftJoin(attachmentText, eq(attachmentText.attachmentId, attachments.id))
        .where(isNull(attachmentText.attachmentId))
        .limit(20)
        .all();
      if (!batch.length) return;
      for (const { id } of batch) await this.read(id);
    }
  }

  private async read(id: string) {
    const row = this.db.select().from(attachments).where(eq(attachments.id, id)).get();
    if (!row) return;
    let result: Result;
    try {
      result = await withTimeout(this.extract(row), READ_TIMEOUT_MS);
    } catch (err) {
      result = { status: 'error', source: null, text: '', error: (err as Error).message };
    }
    const values = { ...result, userId: row.userId, updatedAt: Date.now() };
    this.db
      .insert(attachmentText)
      .values({ attachmentId: id, ...values })
      .onConflictDoUpdate({ target: attachmentText.attachmentId, set: values })
      .run();
  }

  private async extract(row: typeof attachments.$inferSelect): Promise<Result> {
    const file = () => readFile(join(this.dataDir, 'attachments', row.id));
    if (row.mime === 'application/pdf') {
      return { status: 'done', source: 'pdf', text: await pdfText(new Uint8Array(await file())), error: null };
    }
    if (TEXT_TYPES.test(row.mime)) {
      return { status: 'done', source: 'text', text: (await file()).toString('utf8').slice(0, MAX_TEXT), error: null };
    }
    if (!IMAGE_TYPES.has(row.mime)) return { status: 'skipped', source: null, text: '', error: null };
    const cfg = this.settings.effective(row.userId);
    if (!cfg.readImages) return { status: 'skipped', source: 'image', text: '', error: null };
    if (row.size > MAX_IMAGE_BYTES) return { status: 'skipped', source: 'image', text: '', error: 'Larger than 10 MB' };
    if (!hasKeyFor(cfg.keys, cfg.models.images)) {
      return { status: 'error', source: 'image', text: '', error: missingKeyMessage('Reading images', cfg.models.images) };
    }
    const text = await this.readImage(cfg, row.mime, await file());
    return { status: 'done', source: 'image', text: text.slice(0, MAX_TEXT), error: null };
  }

  /** Images skipped or failed before get another go, e.g. once reading them is turned on. */
  retryImages(userId: string) {
    this.db
      .delete(attachmentText)
      .where(and(eq(attachmentText.userId, userId), eq(attachmentText.source, 'image'), ne(attachmentText.status, 'done')))
      .run();
    void this.poke();
  }

  status(userId: string): AttachmentSearchStatus {
    const rows = this.db
      .select({ source: attachmentText.source, status: attachmentText.status, n: count() })
      .from(attachmentText)
      .where(eq(attachmentText.userId, userId))
      .groupBy(attachmentText.source, attachmentText.status)
      .all();
    const n = (source: string, status: string) => rows.find((r) => r.source === source && r.status === status)?.n ?? 0;
    const waiting =
      this.db
        .select({ n: count() })
        .from(attachments)
        .leftJoin(attachmentText, eq(attachmentText.attachmentId, attachments.id))
        .where(and(eq(attachments.userId, userId), isNull(attachmentText.attachmentId)))
        .get()?.n ?? 0;
    const lastError = this.db
      .select({ error: attachmentText.error })
      .from(attachmentText)
      .where(and(eq(attachmentText.userId, userId), eq(attachmentText.status, 'error')))
      .orderBy(sql`${attachmentText.updatedAt} desc`)
      .limit(1)
      .get();
    return {
      waiting,
      documents: n('pdf', 'done') + n('text', 'done'),
      images: { read: n('image', 'done'), notRead: n('image', 'skipped'), failed: n('image', 'error') },
      lastError: lastError?.error ?? null,
    };
  }
}
