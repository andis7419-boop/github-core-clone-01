// git-objects.ts — git object model: SHA-1 hashing, commit/tree encode/decode,
// packfile parse (whole objects plus OFS_DELTA and REF_DELTA) and build (pack v2,
// whole objects only, no deltas), and git delta application.
//
// Written from the git object format itself (see the suite's git-client.ts for the wire
// shapes this must interop with). stdlib only: node:crypto for SHA-1, node:zlib for
// inflate/deflate. No filesystem, no git binary, no clock, no randomness.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

const TYPE_NUMBERS: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUMBER_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

const OID_RE = /^[0-9a-f]{40}$/;

/** Whether `value` is a 40-hex-char object id. */
export function isObjectId(value: string): boolean {
  return OID_RE.test(value);
}

/** The `<type> <len>\0` header plus the object's bytes (the exact bytes SHA-1 hashes). */
export function objectHeader(type: GitObjectType, data: Buffer): Buffer {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return Buffer.concat([header, data]);
}

/** SHA-1 hex of `"<type> <len>\0" + data` — the object's id. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  return createHash('sha1').update(objectHeader(type, data)).digest('hex');
}

// ---------------------------------------------------------------------------
// Commits

export interface BuildCommitOptions {
  tree: string;
  parents: string[];
  message: string;
  /** Epoch seconds for both author and committer lines. */
  timestamp: number;
  /** Bare identity, e.g. `ada iversen <adaiversen@example.invalid>`; the timestamp and `+0000` are appended. */
  author: string;
  committer: string;
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  /** The message bytes after the blank line, verbatim (no trailing newline added or removed). */
  message: string;
  /** The raw author header value, e.g. `ada iversen <adaiversen@example.invalid> 1735689600 +0000`. */
  author: string;
  /** The raw committer header value, same shape as author. */
  committer: string;
  /** The author line's epoch seconds (0 when the line carries no timestamp). */
  timestamp: number;
}

/**
 * Build a commit object's bytes: `tree`, `parent` lines, `author`/`committer` lines with
 * `<timestamp> +0000`, a blank line, then the message verbatim.
 */
export function buildCommit(opts: BuildCommitOptions): Buffer {
  if (!isObjectId(opts.tree)) throw new Error('buildCommit needs a valid tree id');
  for (const parent of opts.parents) {
    if (!isObjectId(parent)) throw new Error('buildCommit needs valid parent ids');
  }
  const lines = [`tree ${opts.tree}`];
  for (const parent of opts.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${opts.author} ${opts.timestamp} +0000`);
  lines.push(`committer ${opts.committer} ${opts.timestamp} +0000`);
  lines.push('');
  return Buffer.from(`${lines.join('\n')}\n${opts.message}`, 'utf8');
}

/** Split a `Name <email> <timestamp> <tz>` ident line into its bare identity and timestamp. */
function splitIdent(value: string): { ident: string; timestamp: number } {
  const match = /^(.*) (\d+) ([+-]\d{4})$/.exec(value);
  if (match === null) return { ident: value, timestamp: 0 };
  return { ident: match[1] ?? value, timestamp: Number(match[2]) };
}

/**
 * Parse a commit object's bytes. Continuation lines (starting with a space, e.g. gpgsig)
 * are skipped; unknown headers are ignored. The author/committer fields keep the raw
 * header value (identity + timestamp + timezone), matching the suite client's model.
 */
export function parseCommit(data: Buffer): ParsedCommit {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (line === '' || line.startsWith(' ')) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isObjectId(tree)) throw new Error('commit has no valid tree header');
  for (const parent of parents) {
    if (!isObjectId(parent)) throw new Error('commit has a bad parent id');
  }
  return { tree, parents, message, author, committer, timestamp: splitIdent(author).timestamp };
}

// ---------------------------------------------------------------------------
// Trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Normalise a mode to git's stored form: octal without leading zeroes (`040000` -> `40000`). */
function normaliseMode(mode: string): string {
  const n = parseInt(mode, 8);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`bad tree entry mode ${JSON.stringify(mode)}`);
  return n.toString(8);
}

/**
 * git's tree-entry sort: byte order of the name, a directory (mode 40000) compared as if
 * its name ended in '/'.
 */
function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/**
 * Build a tree object's bytes from entries, sorted the way git sorts them. Entries may
 * arrive in any order; duplicate names are an error.
 */
export function buildTree(entries: Array<{ mode: string; name: string; oid: string }>): Buffer {
  const normalised: TreeEntry[] = entries.map((entry) => {
    if (!isObjectId(entry.oid)) throw new Error(`tree entry ${entry.name} has a bad object id`);
    return { mode: normaliseMode(entry.mode), name: entry.name, oid: entry.oid };
  });
  normalised.sort(compareTreeEntries);
  for (let i = 1; i < normalised.length; i += 1) {
    if (normalised[i]?.name === normalised[i - 1]?.name) throw new Error(`duplicate tree entry ${normalised[i]?.name ?? ''}`);
  }
  const parts: Buffer[] = [];
  for (const entry of normalised) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a tree object's bytes into entries, in the object's stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > data.length) throw new Error('tree entry has a truncated object id');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    if (!/^[0-7]+$/.test(mode)) throw new Error(`tree entry mode ${JSON.stringify(mode)} is not octal`);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Deltas

/** Read a git variable-length integer (7 bits per byte, little-endian groups). */
function readVarint(buf: Buffer, pos: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let at = pos;
  for (;;) {
    if (at >= buf.length) throw new Error('delta ends mid-varint');
    const byte = buf[at] ?? 0;
    at += 1;
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
    if (shift > 56) throw new Error('delta varint is too long');
  }
  return { value, next: at };
}

/**
 * Apply a git delta to `base`, returning the reconstructed object. Validates the delta's
 * declared base/result sizes and every copy's bounds.
 */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const baseSize = readVarint(delta, 0);
  if (baseSize.value !== base.length) throw new Error(`delta base size ${baseSize.value} does not match ${base.length}`);
  const resultSize = readVarint(delta, baseSize.next);
  const out = Buffer.alloc(resultSize.value);
  let outPos = 0;
  let at = resultSize.next;
  while (at < delta.length) {
    const op = delta[at] ?? 0;
    at += 1;
    if ((op & 0x80) !== 0) {
      // Copy from base: offset bytes on bits 0-3, size bytes on bits 4-6.
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          if (at >= delta.length) throw new Error('delta copy runs past its end');
          offset |= (delta[at] ?? 0) << (i * 8);
          at += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          if (at >= delta.length) throw new Error('delta copy runs past its end');
          size |= (delta[at] ?? 0) << (i * 8);
          at += 1;
        }
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy runs past the base');
      if (outPos + size > out.length) throw new Error('delta copy runs past the result');
      base.copy(out, outPos, offset, offset + size);
      outPos += size;
    } else if (op !== 0) {
      // Insert: low 7 bits are the literal length.
      const size = op & 0x7f;
      if (at + size > delta.length) throw new Error('delta insert runs past its end');
      if (outPos + size > out.length) throw new Error('delta insert runs past the result');
      delta.copy(out, outPos, at, at + size);
      at += size;
      outPos += size;
    } else {
      throw new Error('delta has a zero opcode');
    }
  }
  if (outPos !== out.length) throw new Error(`delta produced ${outPos} bytes, expected ${resultSize.value}`);
  return out;
}

// ---------------------------------------------------------------------------
// Packfiles

const PACK_TYPES = { OBJ_COMMIT: 1, OBJ_TREE: 2, OBJ_BLOB: 3, OBJ_TAG: 4, OBJ_OFS_DELTA: 6, OBJ_REF_DELTA: 7 } as const;

/** Read a pack object header: type number and uncompressed size, both varint-packed. */
function readPackObjectHeader(buf: Buffer, pos: number): { type: number; size: number; next: number } {
  if (pos >= buf.length) throw new Error('pack ends mid-object-header');
  let byte = buf[pos] ?? 0;
  let at = pos + 1;
  const type = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  while ((byte & 0x80) !== 0) {
    if (at >= buf.length) throw new Error('pack ends mid-object-header');
    byte = buf[at] ?? 0;
    at += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { type, size, next: at };
}

/** Read an OFS_DELTA offset: the biased varint git uses for negative offsets. */
function readOfsDeltaOffset(buf: Buffer, pos: number): { offset: number; next: number } {
  if (pos >= buf.length) throw new Error('pack ends mid-delta-offset');
  let byte = buf[pos] ?? 0;
  let at = pos + 1;
  let offset = byte & 0x7f;
  while ((byte & 0x80) !== 0) {
    if (at >= buf.length) throw new Error('pack ends mid-delta-offset');
    byte = buf[at] ?? 0;
    at += 1;
    offset = ((offset + 1) << 7) | (byte & 0x7f);
  }
  return { offset, next: at };
}

/**
 * Inflate the zlib stream starting at `offset`, returning the data and how many input
 * bytes the stream consumed. Node's inflateSync ignores trailing bytes, so the consumed
 * length is found by binary search: success is monotonic in the slice length (a slice
 * ending before the stream's end fails, one ending at or after it succeeds).
 */
function inflateAt(buf: Buffer, offset: number): { data: Buffer; consumed: number } {
  if (offset >= buf.length) throw new Error('pack ends mid-object-data');
  let data: Buffer;
  try {
    data = inflateSync(buf.subarray(offset));
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  let lo = offset + 1;
  let hi = buf.length;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    let ok = false;
    try {
      inflateSync(buf.subarray(offset, mid));
      ok = true;
    } catch {
      ok = false;
    }
    if (ok) hi = mid;
    else lo = mid + 1;
  }
  return { data, consumed: lo - offset };
}

interface PackEntry {
  /** Byte offset of this object's header inside the pack. */
  start: number;
  /** Whole object, once known. */
  type?: GitObjectType;
  data?: Buffer;
  /** OFS_DELTA: start offset of the base object. REF_DELTA: base object id. */
  baseOffset?: number;
  baseOid?: string;
  /** Delta bytes, for delta entries. */
  delta?: Buffer;
}

/**
 * Parse a packfile (v2) fully: header, every object, OFS_DELTA and REF_DELTA applied
 * (delta chains resolved in any order), and the trailing pack checksum verified.
 * Returns every object by id. Throws on corrupt input.
 */
export function parsePack(buf: Buffer): Map<string, { type: GitObjectType; data: Buffer }> {
  if (buf.length < 12) throw new Error('pack is too short for a header');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack has a bad magic');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  // The last 20 bytes are the pack checksum (SHA-1 of everything before it).
  if (buf.length < 32) throw new Error('pack is too short for a checksum');
  const trailer = buf.subarray(buf.length - 20);
  const expect = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  if (!trailer.equals(expect)) throw new Error('pack checksum mismatch');

  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  let at = 12;
  const bodyEnd = buf.length - 20;
  for (let i = 0; i < count; i += 1) {
    if (at >= bodyEnd) throw new Error('pack ends before all objects are read');
    const start = at;
    const header = readPackObjectHeader(buf, at);
    at = header.next;
    if (header.type === PACK_TYPES.OBJ_OFS_DELTA) {
      const ofs = readOfsDeltaOffset(buf, at);
      at = ofs.next;
      const inflated = inflateAt(buf, at);
      at += inflated.consumed;
      if (inflated.data.length !== header.size) throw new Error('delta object size mismatch');
      const entry: PackEntry = { start, baseOffset: start - ofs.offset, delta: inflated.data };
      entries.push(entry);
      byOffset.set(start, entry);
    } else if (header.type === PACK_TYPES.OBJ_REF_DELTA) {
      if (at + 20 > bodyEnd) throw new Error('pack ends mid-delta-base-id');
      const baseOid = buf.subarray(at, at + 20).toString('hex');
      at += 20;
      const inflated = inflateAt(buf, at);
      at += inflated.consumed;
      if (inflated.data.length !== header.size) throw new Error('delta object size mismatch');
      const entry: PackEntry = { start, baseOid, delta: inflated.data };
      entries.push(entry);
      byOffset.set(start, entry);
    } else {
      const type = NUMBER_TYPES[header.type];
      if (type === undefined) throw new Error(`unknown pack object type ${header.type}`);
      const inflated = inflateAt(buf, at);
      at += inflated.consumed;
      if (inflated.data.length !== header.size) throw new Error(`object size mismatch: header says ${header.size}, inflated ${inflated.data.length}`);
      const entry: PackEntry = { start, type, data: inflated.data };
      entries.push(entry);
      byOffset.set(start, entry);
    }
  }

  // Resolve deltas. Whole objects resolve at once; a delta resolves once its base has
  // resolved. Repeat passes until everything resolves or no pass makes progress.
  const resolved = new Map<string, { type: GitObjectType; data: Buffer }>();
  for (const entry of entries) {
    if (entry.type !== undefined && entry.data !== undefined) {
      const oid = hashObject(entry.type, entry.data);
      resolved.set(oid, { type: entry.type, data: entry.data });
    }
  }
  let remaining = entries.filter((entry) => entry.type === undefined);
  while (remaining.length > 0) {
    let progressed = false;
    const nextRemaining: PackEntry[] = [];
    for (const entry of remaining) {
      let base: { type: GitObjectType; data: Buffer } | undefined;
      if (entry.baseOffset !== undefined) {
        const baseEntry = byOffset.get(entry.baseOffset);
        if (baseEntry !== undefined && baseEntry.type !== undefined && baseEntry.data !== undefined) {
          base = { type: baseEntry.type, data: baseEntry.data };
        }
      } else if (entry.baseOid !== undefined) {
        base = resolved.get(entry.baseOid);
      }
      if (base === undefined || entry.delta === undefined) {
        nextRemaining.push(entry);
        continue;
      }
      const data = applyDelta(base.data, entry.delta);
      entry.type = base.type;
      entry.data = data;
      resolved.set(hashObject(base.type, data), { type: base.type, data });
      progressed = true;
    }
    if (!progressed) throw new Error('pack has a delta whose base object is missing');
    remaining = nextRemaining;
  }
  return resolved;
}

/** Encode a pack object header (type + size varint) for buildPack. */
function packObjectHeader(typeNum: number, size: number): Buffer {
  const bytes: number[] = [];
  let remaining = size >> 4;
  bytes.push((typeNum << 4) | (size & 0x0f));
  while (remaining > 0) {
    const byte = remaining & 0x7f;
    remaining >>= 7;
    bytes[bytes.length - 1] |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/**
 * Build a packfile (v2) holding every given object whole — no deltas, always valid.
 * Objects are stored in the order given; callers that need a canonical order sort first.
 * The trailer is the SHA-1 of everything before it.
 */
export function buildPack(objects: Array<{ oid: string; type: GitObjectType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const typeNum = TYPE_NUMBERS[object.type];
    if (typeNum === undefined) throw new Error(`unknown object type ${JSON.stringify(object.type)}`);
    if (!isObjectId(object.oid)) throw new Error(`pack object has a bad id ${JSON.stringify(object.oid)}`);
    if (hashObject(object.type, object.data) !== object.oid) throw new Error(`pack object ${object.oid} does not hash to its id`);
    parts.push(packObjectHeader(typeNum, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}
