import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { Agent, fetch } from 'undici';

/** Thrown for anything a user should see as "this URL cannot be imported". */
export class FetchError extends Error {}

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['64:ff9b::', 96], // NAT64 can reach private IPv4 ranges
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/** True for loopback, private, link-local, CGNAT, multicast and other non-public addresses. */
export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return blocked.check(mapped, 'ipv4');
  const family = isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family === 6) return blocked.check(address, 'ipv6');
  return true;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** DNS lookup that refuses to hand out non-public addresses, checked at connect time. */
function publicLookup(hostname: string, options: { all?: boolean; family?: number }, callback: LookupCallback) {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, []);
    const list = addresses as LookupAddress[];
    if (list.length === 0 || list.some((a) => isPrivateAddress(a.address))) {
      const error: NodeJS.ErrnoException = new FetchError(`${hostname} points to a private network address`);
      error.code = 'ENOTPUBLIC';
      return callback(error, []);
    }
    if (options.all) return callback(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
}

const publicAgent = new Agent({ connect: { lookup: publicLookup as never } });
const anyAgent = new Agent();

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 Nicotes/0.1';

export interface FetchOptions {
  allowPrivate: boolean;
  maxBytes: number;
  timeoutMs?: number;
  accept?: string;
}

export interface Fetched {
  url: string;
  contentType: string;
  body: Buffer;
}

function checkUrl(raw: string, allowPrivate: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchError('Not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FetchError('Only http(s) URLs can be imported');
  if (url.username || url.password) throw new FetchError('URLs with credentials are not supported');
  // IP literals never go through DNS, so check them here.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate && isIP(host) && isPrivateAddress(host)) {
    throw new FetchError('Private network addresses cannot be imported');
  }
  return url;
}

/** Resolves a URL's host and rejects private destinations (for URLs fetched by crawl4ai). */
export async function assertPublicUrl(raw: string, allowPrivate: boolean): Promise<void> {
  const url = checkUrl(raw, allowPrivate);
  if (allowPrivate || isIP(url.hostname.replace(/^\[|\]$/g, ''))) return;
  await new Promise<void>((resolve, reject) =>
    publicLookup(url.hostname, { all: true }, (err) => (err ? reject(new FetchError(err.message)) : resolve())),
  );
}

/** GET with SSRF protection, manual redirect checks, a time limit and a size cap. */
export async function safeFetch(raw: string, options: FetchOptions): Promise<Fetched> {
  const signal = AbortSignal.timeout(options.timeoutMs ?? 15_000);
  let url = checkUrl(raw, options.allowPrivate);
  for (let hop = 0; hop <= 5; hop++) {
    let res;
    try {
      res = await fetch(url, {
        redirect: 'manual',
        signal,
        dispatcher: options.allowPrivate ? anyAgent : publicAgent,
        headers: {
          'user-agent': USER_AGENT,
          accept: options.accept ?? 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
          'accept-language': 'de,en;q=0.8',
        },
      });
    } catch (error) {
      const cause = (error as Error & { cause?: Error }).cause;
      if (cause instanceof FetchError) throw cause;
      if ((error as Error).name === 'TimeoutError') throw new FetchError('The page took too long to respond');
      throw new FetchError(`Could not fetch the page: ${cause?.message ?? (error as Error).message}`);
    }

    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel();
      url = checkUrl(new URL(res.headers.get('location')!, url).href, options.allowPrivate);
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new FetchError(`The site answered ${res.status}${res.status === 403 ? ' (it may block automated access)' : ''}`);
    }

    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > options.maxBytes) throw new FetchError('The page is too large');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res.body ?? []) {
      size += chunk.length;
      if (size > options.maxBytes) throw new FetchError('The page is too large');
      chunks.push(Buffer.from(chunk));
    }
    return { url: url.href, contentType: res.headers.get('content-type') ?? '', body: Buffer.concat(chunks) };
  }
  throw new FetchError('Too many redirects');
}
