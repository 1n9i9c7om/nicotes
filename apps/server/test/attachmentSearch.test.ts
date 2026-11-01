import { describe, expect, it } from 'vitest';
import type { AttachmentSearchStatus, Notebook, Page, SearchResult } from '@nicotes/shared';
import type { ImageReader } from '../src/attachmentText.js';
import { setup } from './helpers.js';
import { makePdf } from './pdf.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

async function withFiles(readImage?: ImageReader) {
  const api = setup({ readImage });
  await api.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
  const nb = (await api.call<Notebook>('POST', '/api/notebooks', { title: 'Paperwork' })).body;
  const upload = async (name: string, type: string, bytes: Uint8Array) => (await api.upload(new File([new Uint8Array(bytes)], name, { type }))).body;
  const pdf = await upload('invoice-march.pdf', 'application/pdf', makePdf(['Invoice 4711 for the Lisbon apartment', 'Total: 120 EUR']));
  const notes = await upload('packing.txt', 'text/plain', new TextEncoder().encode('Snorkel, sun cream, flip-flops'));
  const photo = await upload('IMG_2041.png', 'image/png', PNG);
  const loose = await upload('unused.pdf', 'application/pdf', makePdf(['Invoice that no page shows']));
  const page = (
    await api.call<Page>('POST', '/api/pages', {
      notebookId: nb.id,
      title: 'Trip costs',
      content: `Paid in March.\n\n[the bill](${pdf.url})\n\n[list](${notes.url})\n\n![receipt](${photo.url})`,
    })
  ).body;
  await api.attachmentText.poke();
  return { api, page, loose };
}

const search = async (api: ReturnType<typeof setup>, q: string) =>
  (await api.call<SearchResult[]>('GET', `/api/search?q=${encodeURIComponent(q)}`)).body;

describe('search in attachments', () => {
  it('finds pages by the text of their PDFs and text files', async () => {
    const { api, page } = await withFiles();
    const [hit, ...rest] = await search(api, 'lisbon apartment');
    expect(rest).toEqual([]);
    expect(hit).toMatchObject({ id: page.id, title: 'Trip costs', attachment: { filename: 'invoice-march.pdf' } });
    expect(hit!.excerpt).toContain('\u0001Lisbon\u0002 \u0001apartment\u0002');
    expect((await search(api, 'snorkel'))[0]?.attachment?.filename).toBe('packing.txt');
    // Files no page shows are left out ("unused.pdf" mentions an invoice too).
    expect((await search(api, 'invoice')).map((r) => r.id)).toEqual([page.id]);
    // A page matching by its own text is listed once, as a page.
    const march = await search(api, 'march');
    expect(march.map((r) => [r.id, r.attachment])).toEqual([[page.id, undefined]]);
  });

  it('reads images only once that is turned on', async () => {
    const seen: string[] = [];
    const { api, page } = await withFiles(async (cfg, mime) => {
      seen.push(`${cfg.models.images} ${mime}`);
      return 'Café Lisboa — receipt, 2 × pastel de nata';
    });
    expect(await search(api, 'nata')).toEqual([]);
    let status = (await api.call<AttachmentSearchStatus>('GET', '/api/search/attachments')).body;
    expect(status).toEqual({ waiting: 0, documents: 3, images: { read: 0, notRead: 1, failed: 0 }, lastError: null });

    // On, but without a key for the model.
    await api.call('PATCH', '/api/settings', { readImages: true, imagesModel: 'openai/gpt-5-mini' });
    await api.attachmentText.poke();
    status = (await api.call<AttachmentSearchStatus>('GET', '/api/search/attachments')).body;
    expect(status.images.failed).toBe(1);
    expect(status.lastError).toBe('Reading images needs an OpenRouter API key — add one under Settings.');

    await api.call('PATCH', '/api/settings', { openrouterApiKey: 'sk-or-test' });
    await api.attachmentText.poke();
    expect(seen).toEqual(['openai/gpt-5-mini image/png']);
    const [hit] = await search(api, 'lisboa nata');
    expect(hit).toMatchObject({ id: page.id, attachment: { filename: 'IMG_2041.png' } });
    status = (await api.call<AttachmentSearchStatus>('GET', '/api/search/attachments')).body;
    expect(status.images).toEqual({ read: 1, notRead: 0, failed: 0 });
  });

  it('forgets the text when the page no longer shows the file', async () => {
    const { api, page } = await withFiles();
    await api.call('PATCH', `/api/pages/${page.id}`, { content: 'Paid in March.', baseVersion: page.version });
    expect(await search(api, 'apartment')).toEqual([]);
  });
});
