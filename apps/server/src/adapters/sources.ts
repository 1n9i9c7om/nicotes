import type { AdapterValue } from '@nicotes/shared';

/** A problem worth showing as it is (a wrong token, an unknown sensor), not "Failed: …". */
export class AdapterError extends Error {}

export interface SourceContext {
  config: Record<string, string>;
  secrets: Record<string, string>;
  /** The day to read, "YYYY-MM-DD" in `timeZone`. */
  date: string;
  timeZone: string;
  now: number;
  fetch: typeof fetch;
}

export interface SourceResult {
  values: AdapterValue[];
  /** A sentence for the journal; the values listed otherwise. */
  summary?: string;
}

export interface Source {
  read(ctx: SourceContext): Promise<SourceResult>;
  /** Checks the settings beyond required fields; returns the problem, if any. */
  check?(config: Record<string, string>): string | null;
}

/** Fetches JSON, turning network trouble and error statuses into readable messages. */
export async function getJson(
  ctx: SourceContext,
  url: string,
  service: string,
  init: RequestInit = {},
  statuses: Record<number, string> = {},
): Promise<unknown> {
  let res: Response;
  try {
    res = await ctx.fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const reason = (err as Error).name === 'TimeoutError' ? 'no answer in 20 seconds' : (cause?.code ?? cause?.message ?? (err as Error).message);
    throw new AdapterError(`Could not reach ${service} (${reason})`);
  }
  if (!res.ok) throw new AdapterError(statuses[res.status] ?? `${service} answered ${res.status} ${res.statusText}`.trim());
  try {
    return await res.json();
  } catch {
    throw new AdapterError(`${service} sent something other than JSON`);
  }
}

export const round = (value: number) => Math.round(value * 100) / 100;

/** "Solar 12.3 kWh, Temperature 14.2 °C" */
export const listValues = (values: AdapterValue[]) =>
  values
    .map((v) => {
      const value = v.value === null ? '–' : typeof v.value === 'number' ? v.value.toLocaleString('en-US', { maximumFractionDigits: 2 }) : v.value;
      return `${v.label} ${value}${v.unit && v.value !== null ? ` ${v.unit}` : ''}`;
    })
    .join(', ');
