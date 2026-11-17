// Git smart HTTP: upload-pack protocol v2 (+ a minimal v0 fallback) and
// receive-pack v0, mounted by server.ts under /{owner}/{repo}.git.
//
// Wire shapes follow the suite's in-process git client: pkt-line framing,
// v2 advertisements opening with `version 2`, v0 advertisements opening with
// the `# service=...` preamble, ls-refs / fetch sections, side-band-64k
// packfile framing, and report-status push reports. No git binary, no
// filesystem: every object comes from the store.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';
import { buildPack, parseCommit, parsePack, parseTree } from './git-objects.ts';
import type { GitObjectType } from './git-objects.ts';

export const ZERO_OID = '0'.repeat(40);
const AGENT = 'github-core-clone-01/1.0';
const BODY_LIMIT = 64 * 1024 * 1024;
/** Largest pack chunk inside one sideband pkt-line: 65520 - 4 (header) - 1 (band). */
const SIDEBAND_DATA_MAX = 65515;

export interface GitHttpContext {
  owner: string;
  repo: string;
  /** Path below /{owner}/{repo}.git, e.g. '/info/refs' or '/git-upload-pack'. */
  rest: string;
  query: Map<string, string>;
  requestId: string;
}

// -------------------------------------------------------------------------------------------
// pkt-line
// -------------------------------------------------------------------------------------------

export function encodePktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.allocUnsafe(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

function encodeLines(lines: ReadonlyArray<string | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(pktFlush());
    else if (line === 'delim') parts.push(pktDelim());
    else parts.push(encodePktLine(line));
  }
  return Buffer.concat(parts);
}

type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/**
 * Decode pkt-lines from the head of `buf`. Stops at the first four bytes that
 * are not a hex length (raw pack bytes follow a flush in receive-pack) or at
 * the end of the buffer. `next` is the offset just past the last packet.
 */
function decodePackets(buf: Buffer): { packets: Packet[]; next: number } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, next: offset };
}

function dataLines(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

// -------------------------------------------------------------------------------------------
// small response helpers (every git reply carries the request id)
// -------------------------------------------------------------------------------------------

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer, requestId: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId,
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown, requestId: string): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
  });
  res.end(text);
}

function sendText(res: ServerResponse, status: number, text: string, requestId: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
  });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > BODY_LIMIT) {
        settled = true;
        req.destroy();
        reject(new Error('request body exceeds 64 MiB'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks, total));
      }
    });
    req.on('error', (err: Error) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

// -------------------------------------------------------------------------------------------
// tag peeling (git-objects has no tag parser, so the header is read here)
// -------------------------------------------------------------------------------------------

function tagTarget(data: Buffer): string | null {
  const blank = data.indexOf('\n\n');
  const head = (blank < 0 ? data : data.subarray(0, blank)).toString('utf8');
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) {
      const oid = line.slice(7).trim();
      if (/^[0-9a-f]{40}$/.test(oid)) return oid;
    }
  }
  return null;
}

/** Follow annotated tags until a non-tag object; caps the chase at 10 hops. */
function peelTag(store: Store, repoKey: string, oid: string): string {
  let current = oid;
  for (let hop = 0; hop < 10; hop += 1) {
    const obj = store.getObject(repoKey, current);
    if (obj === undefined || obj.type !== 'tag') return current;
    const target = tagTarget(obj.data);
    if (target === null) return current;
    current = target;
  }
  return current;
}

// -------------------------------------------------------------------------------------------
// advertisements
// -------------------------------------------------------------------------------------------

function advertisementV0(store: Store, repoKey: string, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const refs = store.listRefs(repoKey);
  const head = store.headRef(repoKey);
  const headRef = refs.find((ref) => ref.name === head);
  const caps: string[] = [];
  if (service === 'git-upload-pack') {
    caps.push('side-band-64k', 'thin-pack', 'ofs-delta', 'multi_ack', 'shallow');
  } else {
    caps.push('report-status', 'side-band-64k', 'delete-refs', 'ofs-delta');
  }
  caps.push(`agent=${AGENT}`);
  if (headRef !== undefined) caps.push(`symref=HEAD:${head}`);
  const capText = caps.join(' ');
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`), pktFlush()];
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${capText}\n`));
  } else {
    parts.push(encodePktLine(`${headRef !== undefined ? headRef.oid : ZERO_OID} HEAD\0${capText}\n`));
    for (const ref of refs) {
      parts.push(encodePktLine(`${ref.oid} ${ref.name}\n`));
      const peeled = peelTag(store, repoKey, ref.oid);
      if (peeled !== ref.oid) parts.push(encodePktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function advertisementV2(): Buffer {
  return Buffer.concat([
    encodePktLine('# service=git-upload-pack\n'),
    pktFlush(),
    encodePktLine('version 2\n'),
    encodePktLine(`agent=${AGENT}\n`),
    encodePktLine('ls-refs=unborn\n'),
    encodePktLine('fetch=shallow thin-pack ofs-delta\n'),
    encodePktLine('object-format=sha1\n'),
    pktFlush(),
  ]);
}

// -------------------------------------------------------------------------------------------
// ls-refs (v2)
// -------------------------------------------------------------------------------------------

function handleLsRefs(store: Store, repoKey: string, args: readonly string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const refs = store.listRefs(repoKey);
  const head = store.headRef(repoKey);
  const headRef = refs.find((ref) => ref.name === head);
  const lines: Array<string | 'flush'> = [];
  if (keep('HEAD') && (headRef !== undefined || unborn)) {
    if (headRef !== undefined) {
      lines.push(`${headRef.oid} HEAD${symrefs ? ` symref-target:${head}` : ''}\n`);
    } else {
      lines.push(`unborn HEAD${symrefs ? ` symref-target:${head}` : ''}\n`);
    }
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const peeled = peelTag(store, repoKey, ref.oid);
      if (peeled !== ref.oid) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return encodeLines(lines);
}

// -------------------------------------------------------------------------------------------
// fetch planning: wanted closure minus what the client already holds
// -------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
}

interface FetchPlan {
  objects: Array<{ oid: string; type: GitObjectType; data: Buffer }>;
  shallow: string[];
  unshallow: string[];
}

/**
 * Objects the client already holds: the full closure of its haves, except a
 * shallow boundary commit's parents are not held (the client never received
 * them). That is what makes a deepen fetch deliver the parent generation
 * instead of nothing.
 */
function heldClosure(store: Store, repoKey: string, haves: readonly string[], shallowOld: ReadonlySet<string>): Set<string> {
  const held = new Set<string>();
  const stack = [...haves];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (held.has(oid)) continue;
    const obj = store.getObject(repoKey, oid);
    if (obj === undefined) continue;
    held.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      stack.push(commit.tree);
      if (!shallowOld.has(oid)) {
        for (const parent of commit.parents) stack.push(parent);
      }
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode !== '160000') stack.push(entry.oid);
      }
    } else if (obj.type === 'tag') {
      const target = tagTarget(obj.data);
      if (target !== null) stack.push(target);
    }
  }
  return held;
}

function planFetch(store: Store, repoKey: string, args: FetchArgs): FetchPlan {
  const shallowOld = new Set(args.shallow);
  const held = heldClosure(store, repoKey, args.haves, shallowOld);

  // Wanted closure. `gen` counts parent steps from a want; a depth limit of
  // N admits commits with gen < N (depth 1 = the wanted commits only). Trees,
  // blobs and tag targets always ride along at the same generation.
  const included = new Set<string>();
  const boundary: string[] = [];
  const queue: Array<{ oid: string; gen: number }> = args.wants.map((oid) => ({ oid, gen: 0 }));
  while (queue.length > 0) {
    const item = queue.pop()!;
    if (included.has(item.oid)) continue;
    const obj = store.getObject(repoKey, item.oid);
    if (obj === undefined) continue;
    included.add(item.oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      queue.push({ oid: commit.tree, gen: item.gen });
      if (args.depth === undefined || item.gen + 1 < args.depth) {
        for (const parent of commit.parents) queue.push({ oid: parent, gen: item.gen + 1 });
      } else if (commit.parents.length > 0) {
        boundary.push(item.oid);
      }
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode !== '160000') queue.push({ oid: entry.oid, gen: item.gen });
      }
    } else if (obj.type === 'tag') {
      const target = tagTarget(obj.data);
      if (target !== null) queue.push({ oid: target, gen: item.gen });
    }
  }

  const delivered = new Set<string>();
  for (const oid of included) if (!held.has(oid)) delivered.add(oid);

  // Old shallow boundaries whose parents are all held or delivered now are no
  // longer shallow; the rest stay shallow and the client keeps them.
  const unshallow: string[] = [];
  for (const old of args.shallow) {
    const obj = store.getObject(repoKey, old);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.length === 0) continue;
    if (parents.every((parent) => held.has(parent) || delivered.has(parent))) unshallow.push(old);
  }

  const objects: FetchPlan['objects'] = [];
  for (const oid of [...delivered].sort()) {
    const obj = store.getObject(repoKey, oid);
    if (obj !== undefined) objects.push({ oid, type: obj.type, data: obj.data });
  }
  return { objects, shallow: [...new Set(boundary)].sort(), unshallow: [...new Set(unshallow)].sort() };
}

/** Split a pack into side-band-64k pkt-lines (band 1 = pack data). */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_DATA_MAX) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + SIDEBAND_DATA_MAX));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return parts;
}

function fetchV2Response(store: Store, repoKey: string, args: FetchArgs): Buffer {
  const plan = planFetch(store, repoKey, args);
  const parts: Buffer[] = [];
  if (args.haves.length > 0) {
    parts.push(encodePktLine('acknowledgments\n'));
    const acked = args.haves.filter((have) => store.hasObject(repoKey, have));
    if (acked.length > 0) {
      for (const have of acked) parts.push(encodePktLine(`ACK ${have}\n`));
    } else {
      parts.push(encodePktLine('NAK\n'));
    }
    parts.push(pktDelim());
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(encodePktLine('packfile\n'));
  // Always send a pack, even an empty one: the client requires at least one
  // sideband packet in the packfile section, and an empty pack parses to zero
  // objects, which is exactly what a nothing-new fetch means.
  parts.push(...sidebandPack(buildPack(plan.objects)));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function fetchV0Response(store: Store, repoKey: string, args: FetchArgs): Buffer {
  const plan = planFetch(store, repoKey, args);
  const parts: Buffer[] = [];
  const acked = args.haves.filter((have) => store.hasObject(repoKey, have));
  if (acked.length > 0) {
    for (const have of acked) parts.push(encodePktLine(`ACK ${have}\n`));
  } else {
    parts.push(encodePktLine('NAK\n'));
  }
  for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPack(buildPack(plan.objects)));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function parseFetchArgs(args: readonly string[]): FetchArgs {
  const out: FetchArgs = { wants: [], haves: [], shallow: [], depth: undefined };
  for (const arg of args) {
    if (arg.startsWith('want ')) out.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) out.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) out.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = Number.parseInt(arg.slice(7), 10);
      if (Number.isFinite(n) && n > 0) out.depth = n;
    }
    // thin-pack, no-progress, ofs-delta, filter, deepen-since, deepen-not,
    // done: noted by the client, nothing for the server to do.
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// upload-pack POST (v2 and v0)
// -------------------------------------------------------------------------------------------

async function handleUploadPack(store: Store, req: IncomingMessage, res: ServerResponse, repoKey: string, requestId: string): Promise<void> {
  const body = await readBody(req);
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  if (isV2) {
    const { packets } = decodePackets(body);
    const delimIdx = packets.findIndex((packet) => packet.kind === 'delim');
    const headLines = dataLines(delimIdx < 0 ? packets : packets.slice(0, delimIdx));
    const argLines = dataLines(delimIdx < 0 ? [] : packets.slice(delimIdx + 1));
    const command = headLines[0] ?? '';
    if (command === 'command=ls-refs') {
      sendBuffer(res, 200, 'application/x-git-upload-pack-result', handleLsRefs(store, repoKey, argLines), requestId);
      return;
    }
    if (command === 'command=fetch') {
      sendBuffer(res, 200, 'application/x-git-upload-pack-result', fetchV2Response(store, repoKey, parseFetchArgs(argLines)), requestId);
      return;
    }
    sendText(res, 400, 'unknown upload-pack command\n', requestId);
    return;
  }
  // v0: wants (+ shallow/deepen) up to the first flush, then haves + done.
  const { packets } = decodePackets(body);
  const flushIdx = packets.findIndex((packet) => packet.kind === 'flush');
  if (flushIdx < 0) {
    sendText(res, 400, 'malformed upload-pack request\n', requestId);
    return;
  }
  const first = dataLines(packets.slice(0, flushIdx));
  const second = dataLines(packets.slice(flushIdx + 1));
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', fetchV0Response(store, repoKey, parseFetchArgs([...first, ...second])), requestId);
}

// -------------------------------------------------------------------------------------------
// receive-pack POST (v0)
// -------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').slice(0, 200);
}

async function handleReceivePack(store: Store, req: IncomingMessage, res: ServerResponse, ctx: GitHttpContext): Promise<void> {
  const repoKey = `${ctx.owner}/${ctx.repo}`;
  const body = await readBody(req);
  let packets: Packet[];
  let packStart: number;
  try {
    const decoded = decodePackets(body);
    packets = decoded.packets;
    packStart = decoded.next;
  } catch {
    sendText(res, 400, 'malformed receive-pack request\n', ctx.requestId);
    return;
  }
  const flushIdx = packets.findIndex((packet) => packet.kind === 'flush');
  if (flushIdx < 0) {
    sendText(res, 400, 'malformed receive-pack request\n', ctx.requestId);
    return;
  }
  const commands: PushCommand[] = [];
  for (const packet of packets.slice(0, flushIdx)) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const fields = line.split(' ');
    if (fields.length < 3 || !/^[0-9a-f]{40}$/.test(fields[0]) || !/^[0-9a-f]{40}$/.test(fields[1])) {
      sendText(res, 400, 'malformed receive-pack command\n', ctx.requestId);
      return;
    }
    commands.push({ oldOid: fields[0], newOid: fields[1], ref: fields.slice(2).join(' ') });
  }
  if (commands.length === 0) {
    sendText(res, 400, 'empty receive-pack command list\n', ctx.requestId);
    return;
  }

  // The pack follows the command flush, raw. Delete-only pushes carry none.
  const packBytes = body.subarray(packStart);
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const incoming = parsePack(packBytes);
      for (const obj of incoming.values()) store.putObject(repoKey, obj.type, obj.data);
    } catch (err) {
      unpackError = oneLine(err instanceof Error ? err.message : String(err));
    }
  }

  // Fast-forward is judged against the refs as they stood when the push
  // arrived, so one command list cannot move a ref twice.
  const before = new Map(store.listRefs(repoKey).map((ref) => [ref.name, ref.oid]));
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  let changed = false;
  if (unpackError !== null) {
    for (const command of commands) results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
  } else {
    for (const command of commands) {
      const current = before.get(command.ref);
      if (command.newOid === ZERO_OID) {
        if (current === undefined) {
          results.push({ ref: command.ref, ok: false, reason: 'no such ref' });
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          results.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
        } else {
          store.deleteRef(repoKey, command.ref);
          results.push({ ref: command.ref, ok: true, reason: '' });
          changed = true;
        }
      } else if (command.oldOid === ZERO_OID) {
        if (current !== undefined) {
          results.push({ ref: command.ref, ok: false, reason: 'already exists' });
        } else if (!store.hasObject(repoKey, command.newOid)) {
          results.push({ ref: command.ref, ok: false, reason: 'missing object' });
        } else {
          store.setRef(repoKey, command.ref, command.newOid);
          results.push({ ref: command.ref, ok: true, reason: '' });
          changed = true;
        }
      } else if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'no such ref' });
      } else if (current !== command.oldOid) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else if (command.newOid === current) {
        results.push({ ref: command.ref, ok: true, reason: '' });
      } else if (!store.hasObject(repoKey, command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'missing object' });
      } else if (!store.isAncestor(repoKey, current, command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        store.setRef(repoKey, command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
        changed = true;
      }
    }
  }
  if (changed) {
    const repo = store.getRepo(ctx.owner, ctx.repo);
    if (repo !== undefined) {
      repo.pushed_at = store.nowIso();
      repo.updated_at = store.nowIso();
    }
  }

  // report-status, pkt-lined, carried in side-band-64k band 1.
  const inner: Array<string | 'flush'> = [
    unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`,
  ];
  for (const result of results) {
    inner.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  inner.push('flush');
  const innerBytes = encodeLines(inner);
  const parts: Buffer[] = [];
  for (let offset = 0; offset < innerBytes.length; offset += SIDEBAND_DATA_MAX) {
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), innerBytes.subarray(offset, offset + SIDEBAND_DATA_MAX)])));
  }
  parts.push(pktFlush());
  sendBuffer(res, 200, 'application/x-git-receive-pack-result', Buffer.concat(parts), ctx.requestId);
}

// -------------------------------------------------------------------------------------------
// entry point: called by server.ts after routing and auth
// -------------------------------------------------------------------------------------------

export async function handleGitHttp(store: Store, req: IncomingMessage, res: ServerResponse, ctx: GitHttpContext): Promise<void> {
  try {
    const repoKey = `${ctx.owner}/${ctx.repo}`;
    const repo = store.getRepo(ctx.owner, ctx.repo);
    if (repo === undefined) {
      sendJson(res, 404, { message: 'Not Found' }, ctx.requestId);
      return;
    }
    if (req.method === 'GET' && ctx.rest === '/info/refs') {
      const service = ctx.query.get('service') ?? '';
      if (service === 'git-upload-pack') {
        const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
        const body = isV2 ? advertisementV2() : advertisementV0(store, repoKey, 'git-upload-pack');
        sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', body, ctx.requestId);
        return;
      }
      if (service === 'git-receive-pack') {
        sendBuffer(res, 200, 'application/x-git-receive-pack-advertisement', advertisementV0(store, repoKey, 'git-receive-pack'), ctx.requestId);
        return;
      }
      sendJson(res, 404, { message: 'Not Found' }, ctx.requestId);
      return;
    }
    if (req.method === 'POST' && ctx.rest === '/git-upload-pack') {
      await handleUploadPack(store, req, res, repoKey, ctx.requestId);
      return;
    }
    if (req.method === 'POST' && ctx.rest === '/git-receive-pack') {
      await handleReceivePack(store, req, res, ctx);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' }, ctx.requestId);
  } catch (err) {
    process.stderr.write(`[entry] git-http error: ${err instanceof Error ? err.message : String(err)}\n`);
    try {
      if (!res.writableEnded) sendJson(res, 500, { message: 'Internal Server Error' }, ctx.requestId);
    } catch {
      // The socket is gone; nothing left to do.
    }
  }
}
