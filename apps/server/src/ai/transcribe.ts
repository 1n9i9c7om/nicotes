/** A service with OpenAI's `/audio/transcriptions`: OpenAI, Groq, Speaches, LocalAI, … */
export interface TranscriptionService {
  url: string;
  key: string | null;
  model: string;
}

export class TranscriptionError extends Error {}

/** Recordings take a while; long ones on a small local server even more. */
const TIMEOUT_MS = 10 * 60 * 1000;

/** Sends a recording to the service and returns what was said. */
export async function transcribe(
  service: TranscriptionService,
  file: { bytes: Buffer; filename: string; mime: string },
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(file.bytes)], { type: file.mime }), file.filename);
  form.set('model', service.model);
  form.set('response_format', 'json');
  let res: Response;
  try {
    res = await fetcher(`${service.url}/audio/transcriptions`, {
      method: 'POST',
      headers: service.key ? { authorization: `Bearer ${service.key}` } : {},
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const timeout = (error as Error).name === 'TimeoutError';
    throw new TranscriptionError(timeout ? 'The transcription took too long' : `Cannot reach the transcription service: ${(error as Error).message}`);
  }
  const data = (await res.json().catch(() => ({}))) as { text?: string; error?: { message?: string } | string; detail?: string };
  if (!res.ok) {
    const reason = typeof data.error === 'string' ? data.error : (data.error?.message ?? data.detail);
    if (res.status === 401 || res.status === 403) throw new TranscriptionError('The transcription service rejected the key');
    throw new TranscriptionError(`The transcription service answered ${res.status}${reason ? `: ${reason}` : ''}`);
  }
  return (data.text ?? '').trim();
}
