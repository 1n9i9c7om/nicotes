import type { ApiError as ApiErrorBody, Attachment } from '@nicotes/shared';

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: ApiErrorBody | null,
  ) {
    super(body?.error ?? `Request failed (${status})`);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data);
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
