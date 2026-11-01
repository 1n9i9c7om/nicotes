import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConnectionCheck, Notebook, Page, SearchResult } from '@nicotes/shared';
import { setup } from './helpers.js';

/** A stand-in for an OpenAI-compatible transcription service. */
let server: Server;
let base = '';
const received: { auth?: string; body: string }[] = [];
const read = (req: IncomingMessage) =>
  new Promise<string>((done) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => done(Buffer.concat(chunks).toString('latin1')));
  });

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (req.url === '/v1/models') return json(200, { data: [{ id: 'whisper-1' }, { id: 'tiny' }] });
    if (req.url !== '/v1/audio/transcriptions') return json(404, { error: { message: 'not here' } });
    const body = await read(req);
    received.push({ auth: req.headers.authorization, body });
    if (req.headers.authorization !== 'Bearer good') return json(401, { error: { message: 'bad key' } });
    if (body.includes('broken')) return json(400, { error: { message: 'Audio file might be corrupted' } });
    json(200, { text: ' Remember to call the plumber about the kitchen sink. ' });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => new Promise<void>((done) => server.close(() => done())));

async function withRecording(audio = 'OggS fake opus data') {
  const api = setup();
  await api.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
  const att = (await api.upload(new File([audio], 'Voice note 2026-11-01 09-30.webm', { type: 'audio/webm' }))).body;
  return { api, att, id: att.url.split('/')[3]! };
}

describe('voice notes', () => {
  it('serves byte ranges, which Safari needs to play audio', async () => {
    const { api, att } = await withRecording('0123456789');
    const full = await api.raw(att.url);
    expect(full.status).toBe(200);
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(full.headers.get('content-disposition')).toMatch(/^inline/);
    const get = async (range: string) => {
      const res = await api.rawRange(att.url, range);
      return { status: res.status, body: await res.text(), range: res.headers.get('content-range') };
    };
    expect(await get('bytes=2-4')).toEqual({ status: 206, body: '234', range: 'bytes 2-4/10' });
    expect(await get('bytes=7-')).toEqual({ status: 206, body: '789', range: 'bytes 7-9/10' });
    expect(await get('bytes=-2')).toEqual({ status: 206, body: '89', range: 'bytes 8-9/10' });
    expect(await get('bytes=20-30')).toEqual({ status: 416, body: '', range: 'bytes */10' });
  });

  it('transcribes a recording with the configured service and keeps the text for search', async () => {
    const { api, att, id } = await withRecording();
    const missing = await api.call<{ error: string }>('POST', `/api/attachments/${id}/transcribe`);
    expect(missing).toEqual({ status: 400, body: { error: 'No transcription service is set up (Settings → Voice notes)' } });

    await api.call('PATCH', '/api/settings', { transcribeUrl: `${base}/`, transcribeKey: 'good' });
    expect((await api.call<ConnectionCheck>('POST', '/api/settings/check', { target: 'transcribe' })).body).toEqual({
      ok: true,
      message: 'Reachable · model whisper-1',
    });
    const done = await api.call<{ text: string }>('POST', `/api/attachments/${id}/transcribe`);
    expect(done).toEqual({ status: 200, body: { text: 'Remember to call the plumber about the kitchen sink.' } });
    const sent = received.at(-1)!;
    expect(sent.auth).toBe('Bearer good');
    expect(sent.body).toContain('name="model"\r\n\r\nwhisper-1');
    expect(sent.body).toContain('filename="Voice note 2026-11-01 09-30.webm"');
    expect(sent.body).toContain('OggS fake opus data');

    // The transcript is searchable through the page that has the recording.
    const nb = (await api.call<Notebook>('POST', '/api/notebooks', { title: 'Home' })).body;
    const page = (await api.call<Page>('POST', '/api/pages', { notebookId: nb.id, title: 'Repairs', content: `[🎙️ Voice note](${att.url})` })).body;
    const hits = (await api.call<SearchResult[]>('GET', '/api/search?q=plumber')).body;
    expect(hits).toEqual([expect.objectContaining({ id: page.id, attachment: { id, filename: 'Voice note 2026-11-01 09-30.webm' } })]);
  });

  it('says why the service failed', async () => {
    const { api, id } = await withRecording('broken');
    await api.call('PATCH', '/api/settings', { transcribeUrl: base, transcribeKey: 'good', transcribeModel: 'large' });
    expect((await api.call<ConnectionCheck>('POST', '/api/settings/check', { target: 'transcribe' })).body.message).toBe(
      'Reachable, but it has no model “large” (it has whisper-1, tiny)',
    );
    const failed = await api.call<{ error: string }>('POST', `/api/attachments/${id}/transcribe`);
    expect(failed).toEqual({ status: 502, body: { error: 'The transcription service answered 400: Audio file might be corrupted' } });
    await api.call('PATCH', '/api/settings', { transcribeKey: 'bad' });
    expect((await api.call<{ error: string }>('POST', `/api/attachments/${id}/transcribe`)).body.error).toBe(
      'The transcription service rejected the key',
    );
  });

  it('only transcribes recordings', async () => {
    const api = setup();
    await api.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
    const doc = (await api.upload(new File(['hi'], 'notes.txt', { type: 'text/plain' }))).body;
    await api.call('PATCH', '/api/settings', { transcribeUrl: base });
    const res = await api.call<{ error: string }>('POST', `/api/attachments/${doc.url.split('/')[3]}/transcribe`);
    expect(res).toEqual({ status: 400, body: { error: 'Only recordings can be transcribed' } });
  });
});
