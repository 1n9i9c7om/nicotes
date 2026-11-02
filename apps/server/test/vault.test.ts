import { strToU8, zipSync, type Zippable } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { Notebook, Page, PageSummary, VaultImportResult, VaultPreview } from '@nicotes/shared';
import { splitFrontmatter } from '../src/import/vault.js';
import { setup } from './helpers.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

/** An Obsidian vault as people zip it: one folder with the vault's name. */
function obsidianVault(): Uint8Array {
  const files: Zippable = {
    'Garden/.obsidian/workspace.json': strToU8('{}'),
    'Garden/.trash/old.md': strToU8('gone'),
    'Garden/Inbox.md': strToU8('Quick thoughts, see [[Tomatoes#Watering|watering]] and [[Missing note]].'),
    'Garden/Plants/Tomatoes.md': strToU8(
      [
        '---',
        'tags: [vegetables, "summer"]',
        'aliases:',
        '  - Tomato',
        'sown: 2026-03-01',
        '---',
        '# Tomatoes',
        '',
        'Water daily. #care/watering',
        '',
        '![[tomato.png|300]]',
        '![photo](../Assets/tomato.png)',
        '![[Basil]]',
        'Seeds: [the list](Seeds%20list.md) and [[Plants/Basil.md|basil]].',
        'Pests: [[Basil#Care#Pests^x1]]',
        '',
        '```',
        '#not-a-tag [[not a link]]',
        '```',
      ].join('\n'),
    ),
    'Garden/Plants/Basil.md': strToU8('Smells good. `#nope` [[#Pests]]'),
    'Garden/Plants/Seeds list.md': strToU8('---\ntitle: Seed list 2026\n---\n- [ ] Order seeds'),
    // A folder note: "Herbs/Herbs.md" is the page the folder's notes go under.
    'Garden/Plants/Herbs/Herbs.md': strToU8('All herbs.'),
    'Garden/Plants/Herbs/Mint.md': strToU8('Spreads. [[Seeds list]]'),
    'Garden/Assets/tomato.png': PNG,
    'Garden/Assets/unused.pdf': strToU8('pdf'),
    'Garden/Board.canvas': strToU8('{}'),
  };
  return zipSync(files);
}

async function signedIn() {
  const api = setup();
  await api.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
  return api;
}

const zipFile = (bytes: Uint8Array, name = 'garden.zip') => new File([new Uint8Array(bytes)], name, { type: 'application/zip' });

async function importZip(api: Awaited<ReturnType<typeof signedIn>>, bytes: Uint8Array, mode: 'notebooks' | 'single' = 'notebooks') {
  const preview = await api.postFile<VaultPreview>('/api/import/vault/preview', zipFile(bytes));
  expect(preview.status).toBe(200);
  const result = await api.call<VaultImportResult>('POST', '/api/import/vault', { id: preview.body.id, mode });
  expect(result.status).toBe(201);
  return { preview: preview.body, result: result.body };
}

describe('vault import', () => {
  it('reads the frontmatter notes use', () => {
    expect(splitFrontmatter('---\ntags:\n  - a\n  - "b c"\nnote: |\n  line one\n  line two\nn: 3\n---\nBody').props).toEqual({
      tags: ['a', 'b c'],
      note: 'line one\nline two',
      n: '3',
    });
    expect(splitFrontmatter('No frontmatter\n---\n').props).toEqual({});
  });

  it('previews what an Obsidian vault becomes', async () => {
    const api = await signedIn();
    await api.call('POST', '/api/notebooks', { title: 'Plants' });
    const { status, body } = await api.postFile<VaultPreview>('/api/import/vault/preview', zipFile(obsidianVault()));
    expect(status).toBe(200);
    expect(body).toMatchObject({
      name: 'Garden',
      notes: 6,
      attachments: 1,
      tags: 3,
      notebooks: [
        { title: 'Garden', pages: 1, exists: false },
        { title: 'Plants', pages: 5, exists: true },
      ],
      unresolvedLinks: 1,
    });
    expect(body.skipped).toEqual([
      { path: 'Assets/unused.pdf', reason: 'no note uses it' },
      { path: 'Board.canvas', reason: 'no note uses it' },
    ]);
  });

  it('imports notes, folders, tags, links and files', async () => {
    const api = await signedIn();
    const { result } = await importZip(api, obsidianVault());
    expect(result).toEqual({
      notebooks: [
        { id: expect.any(String), title: 'Garden' },
        { id: expect.any(String), title: 'Plants' },
      ],
      pages: 6,
      attachments: 1,
      tags: 3,
    });
    const all = (await api.call<PageSummary[]>('GET', '/api/pages')).body;
    const byTitle = new Map(all.map((p) => [p.title, p]));
    expect([...byTitle.keys()].sort()).toEqual(['Basil', 'Herbs', 'Inbox', 'Mint', 'Seed list 2026', 'Tomatoes']);
    // The folder note holds the folder's notes.
    expect(byTitle.get('Mint')!.parentId).toBe(byTitle.get('Herbs')!.id);

    const tomatoes = (await api.call<Page>('GET', `/api/pages/${byTitle.get('Tomatoes')!.id}`)).body;
    expect(tomatoes.tags).toEqual(['care/watering', 'summer', 'vegetables']);
    const lines = tomatoes.content.split('\n');
    expect(lines[0]).toBe('**sown:** 2026-03-01');
    // "# Tomatoes" only repeated the title.
    expect(lines[2]).toBe('Water daily. #care/watering');
    expect(tomatoes.content).not.toContain('aliases');
    expect(lines).toContain('Water daily. #care/watering');
    const image = /!\[tomato\.png\]\((\/api\/attachments\/[\w-]+\/tomato\.png)\)/.exec(tomatoes.content);
    expect(image).not.toBeNull();
    // Both ways of embedding the image point at the same attachment.
    expect(tomatoes.content).toContain(`![photo](${image![1]})`);
    // Embeds of notes stay embeds; links keep their (innermost) heading.
    expect(lines).toContain('![[Basil]]');
    expect(lines).toContain('Pests: [[Basil#Pests]]');
    expect(lines).toContain('Seeds: [[Seed list 2026|the list]] and [[Plants/Basil|basil]].');
    expect(tomatoes.content).toContain('```\n#not-a-tag [[not a link]]\n```');
    expect((await api.raw(image![1]!)).status).toBe(200);

    const inbox = (await api.call<Page>('GET', `/api/pages/${byTitle.get('Inbox')!.id}`)).body;
    expect(inbox.content).toBe('Quick thoughts, see [[Tomatoes#Watering|watering]] and [[Missing note]].');
    const mint = (await api.call<Page>('GET', `/api/pages/${byTitle.get('Mint')!.id}`)).body;
    expect(mint.content).toBe('Spreads. [[Seed list 2026]]');
    const basil = (await api.call<Page>('GET', `/api/pages/${byTitle.get('Basil')!.id}`)).body;
    expect(basil.content).toBe('Smells good. `#nope` Pests');
    expect(basil.tags).toEqual([]);

    // Links between imported pages are indexed: Tomatoes shows up as a backlink of Basil.
    const backlinks = (await api.call<{ id: string }[]>('GET', `/api/pages/${byTitle.get('Basil')!.id}/backlinks`)).body;
    expect(backlinks.map((b) => b.id)).toContain(tomatoes.id);
  });

  it('puts everything into one notebook when asked', async () => {
    const api = await signedIn();
    const { result } = await importZip(api, obsidianVault(), 'single');
    expect(result.notebooks.map((n) => n.title)).toEqual(['Garden']);
    const all = (await api.call<PageSummary[]>('GET', '/api/pages')).body;
    const plants = all.find((p) => p.title === 'Plants')!;
    expect(plants.parentId).toBeNull();
    expect(all.find((p) => p.title === 'Tomatoes')!.parentId).toBe(plants.id);
  });

  it('round-trips a Nicotes export', async () => {
    const api = await signedIn();
    const nb = (await api.call<Notebook>('POST', '/api/notebooks', { title: 'Travel: 2027' })).body;
    const photo = (await api.upload(new File([PNG], 'beach.png', { type: 'image/png' }))).body;
    const trip = (await api.call<Page>('POST', '/api/pages', { notebookId: nb.id, title: 'Lisbon / Porto?', content: `See [[Gaia]].\n\n![beach](${photo.url})` })).body;
    await api.call('POST', '/api/pages', { notebookId: nb.id, parentId: trip.id, title: 'Gaia', content: 'Cellars.' });
    await api.call('PUT', `/api/pages/${trip.id}/tags`, { tags: ['portugal'] });
    const zip = new Uint8Array(await (await api.raw('/api/export')).arrayBuffer());

    await api.call('DELETE', `/api/notebooks/${nb.id}`);
    const { result } = await importZip(api, zip);
    expect(result.notebooks.map((n) => n.title)).toEqual(['Travel- 2027']);
    const all = (await api.call<PageSummary[]>('GET', '/api/pages')).body;
    const copy = all.find((p) => p.title === 'Lisbon / Porto?')!;
    expect(all.find((p) => p.title === 'Gaia')!.parentId).toBe(copy.id);
    const page = (await api.call<Page>('GET', `/api/pages/${copy.id}`)).body;
    expect(page.tags).toEqual(['portugal']);
    expect(page.createdAt).toBe(trip.createdAt);
    expect(page.content).toMatch(/^See \[\[Gaia\]\]\.\n\n!\[beach\]\(\/api\/attachments\/[\w-]+\/[\w-]+-beach\.png\)$/);
  });

  it('refuses what it cannot use', async () => {
    const api = await signedIn();
    const notZip = await api.postFile<{ error: string }>('/api/import/vault/preview', new File(['hello'], 'notes.zip'));
    expect(notZip).toEqual({ status: 400, body: { error: 'This zip file cannot be read' } });
    const noNotes = await api.postFile<{ error: string }>('/api/import/vault/preview', zipFile(zipSync({ 'a.png': PNG })));
    expect(noNotes.body.error).toBe('There are no Markdown notes (.md files) in this zip');
    expect((await api.call('POST', '/api/import/vault', { id: 'expired', mode: 'single' })).status).toBe(409);
  });
});
