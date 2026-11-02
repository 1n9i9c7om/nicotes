import type { ApiError as ApiErrorBody, Attachment } from '@nicotes/shared';
import { keepAnswer, offlineAnswer, reachedServer } from './offline';

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: ApiErrorBody | null,
  ) {
    super(body?.error ?? `Request failed (${status})`);
  }
}

/** The server could not be reached (no network, or a proxy without its server behind it). */
export class OfflineError extends Error {
  constructor() {
    super('Offline: the server cannot be reached');
  }
}

const UNREACHABLE = new Set([502, 503, 504]);

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (UNREACHABLE.has(res.status)) throw new OfflineError();
  } catch {
    reachedServer(false);
    // Reading works on from the notes kept on this device.
    const kept = method === 'GET' ? await offlineAnswer(path).catch(() => undefined) : undefined;
    if (kept !== undefined) return kept as T;
    throw new OfflineError();
  }
  reachedServer(true);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data);
  if (method === 'GET') keepAnswer(path, data);
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  delete: (path: string) => request<void>('DELETE', path),
};

/** Uploads a file as an attachment (multipart; the custom header satisfies the CSRF check). */
export async function uploadFile(file: File, pageId?: string): Promise<Attachment> {
  const form = new FormData();
  form.set('file', file);
  if (pageId) form.set('pageId', pageId);
  const res = await fetch('/api/attachments', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'x-requested-with': 'nicotes' },
    body: form,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return data as Attachment;
}

/** Uploads one file to an API route (multipart, with the CSRF header), e.g. a zip to import. */
export async function postFile<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.set('file', file);
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'x-requested-with': 'nicotes' },
    body: form,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

/** POSTs JSON and reads the server-sent events of the response, one parsed `data:` object at a time. */
export async function postStream<E>(path: string, body: unknown, onEvent: (event: E) => void, signal?: AbortSignal) {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text();
    throw new ApiError(res.status, text ? JSON.parse(text) : null);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const handle = (line: string) => {
    if (line.startsWith('data:')) onEvent(JSON.parse(line.slice(5)) as E);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    lines.forEach(handle);
  }
  handle(buffer);
}
