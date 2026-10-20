import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';

/*
 * Minimal streaming tar.gz writer/reader for backups. Not zip (fflate): fflate keeps no
 * ZIP64 support, so archives would break past 4 GB of attachments, and streaming avoids
 * holding all attachments in memory. Only plain files with short names are needed here,
 * so the ustar subset below is enough; any tar tool (and 7-Zip / Windows Explorer) opens it.
 */

const BLOCK = 512;
/** ustar stores sizes as 11 octal digits. */
const MAX_ENTRY_SIZE = 8 ** 11 - 1;

export interface TarSource {
  /** Path inside the archive (forward slashes, < 100 bytes). */
  name: string;
  /** File on disk to copy in. */
  path: string;
}

function header(name: string, size: number, mtime: number): Buffer {
  const buf = Buffer.alloc(BLOCK);
  if (Buffer.byteLength(name) > 99) throw new Error(`Archive path too long: ${name}`);
  if (size > MAX_ENTRY_SIZE) throw new Error(`File too large for the archive: ${name}`);
  const octal = (value: number, offset: number, length: number) =>
    buf.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length, 'ascii');
  buf.write(name, 0, 100, 'utf8');
  octal(0o644, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(size, 124, 12);
  octal(Math.floor(mtime / 1000), 136, 12);
  buf.write('        ', 148, 8, 'ascii'); // checksum field counts as spaces while summing
  buf.write('0', 156, 1, 'ascii');
  buf.write('ustar\u000000', 257, 8, 'ascii');
  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return buf;
}

async function* tarStream(sources: TarSource[]): AsyncGenerator<Buffer> {
  for (const source of sources) {
    const info = await stat(source.path).catch(() => null);
    if (!info?.isFile()) continue; // vanished since it was listed
    yield header(source.name, info.size, info.mtimeMs);
    let written = 0;
    if (info.size > 0) {
      // Reads exactly the stat'ed length, so a file that grows meanwhile cannot corrupt the tar.
      for await (const chunk of createReadStream(source.path, { end: info.size - 1 }) as AsyncIterable<Buffer>) {
        written += chunk.length;
        yield chunk;
      }
    }
    if (written !== info.size) throw new Error(`${source.name} changed while it was archived`);
    const pad = (BLOCK - (info.size % BLOCK)) % BLOCK;
    if (pad) yield Buffer.alloc(pad);
  }
  yield Buffer.alloc(BLOCK * 2);
}

/** Writes `sources` into a gzip-compressed tar file at `target`. */
export async function writeTarGz(target: string, sources: TarSource[]): Promise<void> {
  await pipeline(Readable.from(tarStream(sources)), createGzip(), createWriteStream(target));
}

function parseOctal(buf: Buffer, offset: number, length: number): number {
  const text = buf.toString('ascii', offset, offset + length).replace(/\0.*$/s, '').trim();
  return text ? parseInt(text, 8) : 0;
}

/**
 * Extracts a tar.gz file. `destination` maps each entry name to a path on disk, or null to
 * skip it; that is where callers restrict which names are accepted.
 */
export async function extractTarGz(file: string, destination: (name: string) => string | null): Promise<string[]> {
  const extracted: string[] = [];
  let pending: Buffer = Buffer.alloc(0);
  let remaining = 0; // bytes of the current entry still to come
  let padding = 0;
  let out: Awaited<ReturnType<typeof open>> | null = null;
  let ended = false;

  try {
    for await (const chunk of createReadStream(file).pipe(createGunzip()) as AsyncIterable<Buffer>) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (!ended) {
        if (remaining > 0) {
          if (!pending.length) break;
          const part = pending.subarray(0, Math.min(remaining, pending.length));
          if (out) await out.write(part);
          remaining -= part.length;
          pending = pending.subarray(part.length);
          if (remaining === 0) {
            await out?.close();
            out = null;
          }
          continue;
        }
        if (padding > 0) {
          const skip = Math.min(padding, pending.length);
          if (!skip) break;
          padding -= skip;
          pending = pending.subarray(skip);
          continue;
        }
        if (pending.length < BLOCK) break;
        const block = pending.subarray(0, BLOCK);
        pending = pending.subarray(BLOCK);
        if (block.every((b) => b === 0)) {
          ended = true;
          break;
        }
        const prefix = block.toString('utf8', 345, 500).replace(/\0.*$/s, '');
        const base = block.toString('utf8', 0, 100).replace(/\0.*$/s, '');
        const name = prefix ? `${prefix}/${base}` : base;
        const size = parseOctal(block, 124, 12);
        const type = String.fromCharCode(block[156]!);
        remaining = size;
        padding = (BLOCK - (size % BLOCK)) % BLOCK;
        const target = type === '0' || type === '\0' ? destination(name) : null;
        if (target) {
          await mkdir(dirname(target), { recursive: true });
          out = await open(target, 'w');
          extracted.push(name);
        }
        if (size === 0) {
          await out?.close();
          out = null;
        }
      }
    }
  } finally {
    await out?.close();
  }
  if (!ended || remaining > 0) throw new Error('The archive is incomplete');
  return extracted;
}
