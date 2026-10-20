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
