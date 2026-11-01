import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { canvasMarkdown, parseCanvas, type Notebook, type Page, type PageSummary, type SearchResult, type VaultPreview } from '@nicotes/shared';
import { setup } from './helpers.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]);
const SCENE = 'N4IgLgngDgpiBcIA'.repeat(30);

async function withCanvas() {
  const api = setup();
  await api.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
  const nb = (await api.call<Notebook>('POST', '/api/notebooks', { title: 'Home' })).body;
  const budget = (await api.call<Page>('POST', '/api/pages', { notebookId: nb.id, title: 'Budget', content: 'Money.' })).body;
  const photo = (await api.upload(new File([PNG], 'sketch.png', { type: 'image/png' }))).body;
  const content = canvasMarkdown(
    [
      { id: 'aB3d', text: 'Kitchen layout' },
      { id: 'xY9z', text: 'Costs: see [[Budget]]' },
    ],
    [{ id: 'f1', name: 'sketch.png', url: photo.url }],
    SCENE,
  );
  const plan = (await api.call<Page>('POST', '/api/pages', { notebookId: nb.id, title: 'Plan', content })).body;
  return { api, nb, budget, plan, photo };
}

describe('canvas pages', () => {
  it('are marked in the page list, linked and searchable by their texts', async () => {
    const { api, budget, plan } = await withCanvas();
    const list = (await api.call<PageSummary[]>('GET', '/api/pages')).body;
    expect(list.map((p) => [p.title, p.canvas])).toEqual(
      expect.arrayContaining([
        ['Plan', true],
        ['Budget', false],
      ]),
    );
    const backlinks = (await api.call<{ id: string }[]>('GET', `/api/pages/${budget.id}/backlinks`)).body;
    expect(backlinks.map((b) => b.id)).toEqual([plan.id]);
    expect((await api.call<SearchResult[]>('GET', '/api/search?q=kitchen')).body.map((r) => r.id)).toEqual([plan.id]);
  });

  it('export as Excalidraw drawings', async () => {
    const { api, plan } = await withCanvas();
    await api.call('PUT', `/api/pages/${plan.id}/tags`, { tags: ['home'] });
    const zip = unzipSync(new Uint8Array(await (await api.raw('/api/export')).arrayBuffer()));
    const file = strFromU8(zip['Home/Plan.excalidraw.md']!);
    expect(file.startsWith(`---\nid: "${plan.id}"\ntitle: "Plan"\ntags: ["home"]\n`)).toBe(true);
    expect(file).toContain('\nexcalidraw-plugin: parsed\n');
    expect(file).toMatch(/f1: !\[sketch\.png\]\(\.\.\/attachments\/[\w-]+-sketch\.png\)/);
    expect(zip['Home/Plan.md']).toBeUndefined();
    expect(Object.keys(zip).filter((k) => k.startsWith('Home/'))).toEqual(['Home/Budget.md', 'Home/Plan.excalidraw.md']);
  });
});

describe('canvas import', () => {
  it('turns an exported drawing back into a canvas page with its image', async () => {
    const { api, nb, plan } = await withCanvas();
    const exported = new Uint8Array(await (await api.raw('/api/export')).arrayBuffer());
    await api.call('DELETE', `/api/notebooks/${nb.id}`);
    const preview = await api.postFile<VaultPreview>('/api/import/vault/preview', new File([exported], 'export.zip'));
    expect(preview.body.skipped).toEqual([]);
    expect((await api.call('POST', '/api/import/vault', { id: preview.body.id, mode: 'notebooks' })).status).toBe(201);

    const list = (await api.call<PageSummary[]>('GET', '/api/pages')).body;
    const copy = list.find((p) => p.title === 'Plan' && p.id !== plan.id)!;
    expect(copy.canvas).toBe(true);
    const page = (await api.call<Page>('GET', `/api/pages/${copy.id}`)).body;
    expect(page.tags).toEqual([]);
    const parsed = parseCanvas(page.content);
    expect(parsed.drawing).toEqual({ compressed: true, data: SCENE });
    expect(parsed.files).toEqual([{ id: 'f1', name: 'sketch.png', url: expect.stringMatching(/^\/api\/attachments\/[\w-]+\/[\w-]+-sketch\.png$/) }]);
    expect((await api.raw(parsed.files[0]!.url)).status).toBe(200);
  });
});
