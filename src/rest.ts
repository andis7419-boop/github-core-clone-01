// REST v3 under /api/v3 (DESIGN.md section 5).
// Original work: every line written for this entry. No wall clock, no unseeded randomness, no filesystem access.
// Handler contract (see NOTES.md): server.ts calls
//   handleRest(store, req, res, { token })
// for any request whose path starts with /api/v3. The handler sends the whole
// response itself (status, application/json, X-GitHub-Request-Id) and always
// resolves; it never throws to the caller.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';
import { buildCommit, buildTree, parseCommit, parseTree } from './git-objects.ts';

export interface HandlerContext {
  /**
   * The bearer token expected on every request. When absent, the handler
   * falls back to process.env.MAKEFUN_SHOP_TOKEN; when that is empty too,
   * auth is open (server.ts authorizes before dispatching, so in the real
   * entry this check is a second line of defence, not the only one).
   */
  token?: string;
  /**
   * A request id pre-minted by server.ts. When absent (standalone use, or
   * tests driving the handler directly) one is minted from the store.
   */
  requestId?: string;
  // server.ts's RequestContext carries segments/query/readBody as well; this
  // handler re-parses the raw URL itself and ignores those fields.
  segments?: string[];
  query?: Map<string, string>;
  readBody?: (maxBytes?: number) => Promise<Buffer>;
}

function expectedToken(ctx: HandlerContext): string {
  if (ctx.token !== undefined && ctx.token !== '') return ctx.token;
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

type Json = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Small HTTP helpers

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(rid: string, res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const text = body === undefined ? '' : JSON.stringify(body);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-request-id': rid,
  };
  if (extraHeaders !== undefined) {
    for (const k of Object.keys(extraHeaders)) headers[k] = extraHeaders[k] as string;
  }
  res.writeHead(status, headers);
  res.end(text);
}

function sendNoBody(rid: string, res: ServerResponse, status: number): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': rid,
  });
  res.end();
}

function err(rid: string, res: ServerResponse, status: number, message: string): void {
  sendJson(rid, res, status, { message });
}

/** Parse `a=1&b=2` into a plain object (no URL object: keeps the hot path cheap). */
function parseQuery(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw === undefined || raw === '') return out;
  for (const part of raw.split('&')) {
    const eq = part.indexOf('=');
    if (eq === -1) {
      if (part !== '') out[decodeURIComponent(part)] = '';
    } else {
      out[decodeURIComponent(part.slice(0, eq))] = decodeURIComponent(part.slice(eq + 1));
    }
  }
  return out;
}

function toInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function originOf(req: IncomingMessage): string {
  const host = req.headers.host;
  return host !== undefined && host !== '' ? `http://${host}` : 'http://127.0.0.1';
}

function decodeSegment(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Issue comments. The frozen Store API has no comment methods, so comments live
// in a WeakMap keyed by the shared Issue object: REST and GraphQL see the same
// list because they share the same store instance. Ids are one sequential
// counter (creation order), which keeps replay deterministic.
export interface IssueComment {
  id: number;
  nodeId: string;
  body: string;
  created_at: string;
}

const commentLists = new WeakMap<object, IssueComment[]>();
let commentCounter = 0;

export function addIssueComment(issue: object, body: string, nowIso: string): IssueComment {
  let list = commentLists.get(issue);
  if (list === undefined) {
    list = [];
    commentLists.set(issue, list);
  }
  commentCounter += 1;
  const comment: IssueComment = {
    id: commentCounter,
    nodeId: Buffer.from(`IssueComment:${commentCounter}`, 'utf8').toString('base64'),
    body,
    created_at: nowIso,
  };
  list.push(comment);
  return comment;
}

export function listIssueComments(issue: object): IssueComment[] {
  return commentLists.get(issue) ?? [];
}

// ---------------------------------------------------------------------------
// Git tree helpers (used for contents-on-a-branch, directory listings and the
// pull-request file diff). They work only through the frozen Store API plus
// git-objects' parse/build functions.

/** Resolve a ref-ish (branch name, full ref, or raw commit oid) to a commit oid. */
export function resolveRefTip(store: Store, repoKey: string, ref: string | undefined, defaultBranch: string): string | undefined {
  if (ref === undefined || ref === '') return store.getRef(repoKey, `refs/heads/${defaultBranch}`);
  if (ref.startsWith('refs/')) return store.getRef(repoKey, ref);
  const asBranch = store.getRef(repoKey, `refs/heads/${ref}`);
  if (asBranch !== undefined) return asBranch;
  const obj = store.getObject(repoKey, ref);
  return obj !== undefined && obj.type === 'commit' ? ref : undefined;
}

/** Flatten a commit's tree into path -> blob oid. */
export function treeFiles(store: Store, repoKey: string, tipOid: string): Map<string, string> {
  const out = new Map<string, string>();
  const tip = store.getObject(repoKey, tipOid);
  if (tip === undefined || tip.type !== 'commit') return out;
  const walk = (treeOid: string, prefix: string): void => {
    const obj = store.getObject(repoKey, treeOid);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.mode === '40000') walk(e.oid, path);
      else out.set(path, e.oid);
    }
  };
  walk(parseCommit(tip.data).tree, '');
  return out;
}

function rebuildTree(store: Store, repoKey: string, files: Map<string, string>): string {
  const build = (dir: string): string => {
    const entries: Array<{ mode: string; name: string; oid: string }> = [];
    const subdirs = new Set<string>();
    for (const [path, oid] of files) {
      if (dir !== '' && !path.startsWith(`${dir}/`)) continue;
      const rest = dir === '' ? path : path.slice(dir.length + 1);
      const slash = rest.indexOf('/');
      if (slash === -1) entries.push({ mode: '100644', name: rest, oid });
      else subdirs.add(rest.slice(0, slash));
    }
    for (const sub of subdirs) entries.push({ mode: '40000', name: sub, oid: build(dir === '' ? sub : `${dir}/${sub}`) });
    return store.putObject(repoKey, 'tree', buildTree(entries));
  };
  return build('');
}

/**
 * Commit one file on an arbitrary ref (the store's createOrUpdateFile only
 * serves the default branch). A missing branch is created from the default
 * branch tip, which is how the contents route creates a branch. Returns the
 * same shape as Store.createOrUpdateFile.
 */
export function writeFileOnRef(
  store: Store,
  repoKey: string,
  ref: string,
  path: string,
  contentBase64: string,
  message: string,
  sha: string | undefined,
): { commitSha: string; blobSha: string; created: boolean } | { error: 'stale' | 'not_found' } {
  let tip = store.getRef(repoKey, ref);
  if (tip === undefined) {
    const repo = store.getRepo(repoKey.slice(0, repoKey.indexOf('/')), repoKey.slice(repoKey.indexOf('/') + 1));
    if (repo === undefined) return { error: 'not_found' };
    tip = store.getRef(repoKey, `refs/heads/${repo.default_branch}`);
  }
  const files = new Map<string, string>();
  const parents: string[] = [];
  if (tip !== undefined) {
    const obj = store.getObject(repoKey, tip);
    if (obj !== undefined && obj.type === 'commit') {
      files.clear();
      for (const [p, oid] of treeFiles(store, repoKey, tip)) files.set(p, oid);
      parents.push(tip);
    }
  }
  const existed = files.has(path);
  const blobSha = store.putObject(repoKey, 'blob', Buffer.from(contentBase64, 'base64'));
  if (sha !== undefined && existed && files.get(path) !== sha) return { error: 'stale' };
  if (sha !== undefined && !existed) return { error: 'stale' };
  files.set(path, blobSha);
  const tree = rebuildTree(store, repoKey, files);
  const author = `${store.viewer.name} <${store.viewer.email}>`;
  const commitSha = store.putObject(
    repoKey,
    'commit',
    buildCommit({ tree, parents, message: message === '' ? `Update ${path}` : message, timestamp: store.nowSec(), author, committer: author }),
  );
  store.setRef(repoKey, ref, commitSha);
  return { commitSha, blobSha, created: !existed };
}

/** Read one blob through a ref's tree; undefined when the path is not a file. */
export function readFileOnRef(store: Store, repoKey: string, tipOid: string, path: string): { sha: string; contentBase64: string } | undefined {
  const files = treeFiles(store, repoKey, tipOid);
  const oid = files.get(path);
  if (oid === undefined) return undefined;
  const blob = store.getObject(repoKey, oid);
  if (blob === undefined) return undefined;
  return { sha: oid, contentBase64: blob.data.toString('base64') };
}

/** Immediate children of a directory in a ref's tree; undefined when not a dir. */
export function listDirOnRef(
  store: Store,
  repoKey: string,
  tipOid: string,
  dirPath: string,
): Array<{ type: string; name: string; path: string; sha: string }> | undefined {
  const tip = store.getObject(repoKey, tipOid);
  if (tip === undefined || tip.type !== 'commit') return undefined;
  let treeOid = parseCommit(tip.data).tree;
  if (dirPath !== '') {
    let found = false;
    for (const seg of dirPath.split('/')) {
      const obj = store.getObject(repoKey, treeOid);
      if (obj === undefined || obj.type !== 'tree') return undefined;
      found = false;
      for (const e of parseTree(obj.data)) {
        if (e.name === seg && e.mode === '40000') {
          treeOid = e.oid;
          found = true;
          break;
        }
      }
      if (!found) return undefined;
    }
  }
  const obj = store.getObject(repoKey, treeOid);
  if (obj === undefined || obj.type !== 'tree') return undefined;
  const out: Array<{ type: string; name: string; path: string; sha: string }> = [];
  for (const e of parseTree(obj.data)) {
    out.push({
      type: e.mode === '40000' ? 'dir' : 'file',
      name: e.name,
      path: dirPath === '' ? e.name : `${dirPath}/${e.name}`,
      sha: e.oid,
    });
  }
  return out;
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 1) if (data[i] === 10) n += 1;
  if (data[data.length - 1] !== 10) n += 1;
  return n;
}

/** Changed files between a pull's base tip and head tip (REST files + GraphQL files). */
export function pullChangedFiles(
  store: Store,
  repoKey: string,
  baseTip: string,
  headTip: string,
): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
  const base = treeFiles(store, repoKey, baseTip);
  const head = treeFiles(store, repoKey, headTip);
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    if (b === h) continue;
    if (b === undefined && h !== undefined) {
      const blob = store.getObject(repoKey, h);
      const additions = blob === undefined ? 0 : countLines(blob.data);
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (h === undefined && b !== undefined) {
      const blob = store.getObject(repoKey, b);
      const deletions = blob === undefined ? 0 : countLines(blob.data);
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (b !== undefined && h !== undefined) {
      const oldBlob = store.getObject(repoKey, b);
      const newBlob = store.getObject(repoKey, h);
      const deletions = oldBlob === undefined ? 0 : countLines(oldBlob.data);
      const additions = newBlob === undefined ? 0 : countLines(newBlob.data);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  out.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------------------
// The handler

interface Route {
  method: string;
  segments: string[];
  query: Record<string, string>;
  body: Json | undefined;
  rid: string;
}

export async function handleRest(store: Store, req: IncomingMessage, res: ServerResponse, ctx: HandlerContext): Promise<void> {
  const rid = ctx.requestId ?? store.nextRequestId();
  const token = expectedToken(ctx);
  const method = req.method ?? 'GET';
  const rawUrl = req.url ?? '/';
  const qmark = rawUrl.indexOf('?');
  const rawPath = qmark === -1 ? rawUrl : rawUrl.slice(0, qmark);
  const query = parseQuery(qmark === -1 ? undefined : rawUrl.slice(qmark + 1));
  const parts = rawPath.split('/');
  // parts[0] is '', parts[1] 'api', parts[2] 'v3'; the rest is the route.
  const segments: string[] = [];
  for (let i = 3; i < parts.length; i += 1) {
    // A trailing slash contributes no segment (GET /api/v3/ is the root).
    if (parts[i] === '') continue;
    const decoded = decodeSegment(parts[i] as string);
    if (decoded === null) {
      err(rid, res, 404, 'Not Found');
      return;
    }
    segments.push(decoded);
  }

  // Auth first: every /api/v3 route needs the exact bearer token (when one
  // is configured; server.ts already enforces this before dispatching).
  const auth = req.headers.authorization;
  if (token !== '' && auth !== `Bearer ${token}`) {
    err(rid, res, 401, 'Bad credentials');
    return;
  }

  // Body for the methods that carry one. Empty body is {}; malformed JSON is 400.
  let body: Json | undefined;
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    let text = '';
    try {
      text = await readBody(req);
    } catch {
      err(rid, res, 400, 'Could not read request body');
      return;
    }
    if (text.trim() !== '') {
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          err(rid, res, 400, 'Request body must be a JSON object');
          return;
        }
        body = parsed as Json;
      } catch {
        err(rid, res, 400, 'Malformed JSON in request body');
        return;
      }
    } else {
      body = {};
    }
  }

  const route: Route = { method, segments, query, body, rid };
  try {
    await dispatch(store, req, res, route);
  } catch {
    err(rid, res, 500, 'Internal Server Error');
  }
}

function repoKeyOf(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function paginate<T>(items: T[], query: Record<string, string>): { page: T[]; hasNext: boolean; pageNum: number; perPage: number } {
  const perPage = Math.min(100, toInt(query.per_page, 30));
  const pageNum = toInt(query.page, 1);
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), hasNext: start + perPage < items.length, pageNum, perPage };
}

function linkHeader(origin: string, base: string, query: Record<string, string>, pageNum: number, perPage: number): string {
  const q: Record<string, string> = { ...query, page: String(pageNum + 1), per_page: String(perPage) };
  const qs = Object.keys(q)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(q[k] as string)}`)
    .join('&');
  return `<${origin}${base}?${qs}>; rel="next"`;
}

async function dispatch(store: Store, req: IncomingMessage, res: ServerResponse, route: Route): Promise<void> {
  const rid = route.rid;
  const { method, segments: s, query, body } = route;
  const origin = originOf(req);

  // GET /api/v3/
  if (s.length === 0) {
    if (method !== 'GET') {
      err(rid, res, 404, 'Not Found');
      return;
    }
    sendJson(rid, res, 200, { current_user_url: `${origin}/api/v3/user` }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }

  // GET /api/v3/meta
  if (s.length === 1 && s[0] === 'meta') {
    if (method !== 'GET') {
      err(rid, res, 404, 'Not Found');
      return;
    }
    sendJson(rid, res, 200, { installed_version: '1.0.0' });
    return;
  }

  // GET /api/v3/user  (the token owner's profile; the MCP setup reads login here)
  if (s.length === 1 && s[0] === 'user') {
    if (method !== 'GET') {
      err(rid, res, 404, 'Not Found');
      return;
    }
    const v = store.viewer;
    sendJson(rid, res, 200, { login: v.login, id: v.id, node_id: '', name: v.name, email: v.email, type: 'User' });
    return;
  }

  // /api/v3/user/repos
  if (s.length === 2 && s[0] === 'user' && s[1] === 'repos') {
    if (method === 'GET') {
      const all = store.listViewerRepos();
      const { page, hasNext, pageNum, perPage } = paginate(all, query);
      const extra = hasNext ? { link: linkHeader(origin, '/api/v3/user/repos', query, pageNum, perPage) } : undefined;
      sendJson(rid, res, 200, page, extra);
      return;
    }
    if (method === 'POST') {
      const name = typeof body?.name === 'string' ? (body.name as string) : '';
      if (name === '') {
        err(rid, res, 422, 'name is required');
        return;
      }
      const description = typeof body?.description === 'string' ? (body.description as string) : '';
      const repo = store.createRepo(name, description);
      if (repo === null) {
        err(rid, res, 422, 'Repository already exists');
        return;
      }
      // The suite posts private:true and reads it back; the store's Repo type
      // declares private:false, so set the requested flag through a cast.
      (repo as unknown as { private: boolean }).private = body?.private === true;
      sendJson(rid, res, 201, repo);
      return;
    }
    err(rid, res, 404, 'Not Found');
    return;
  }

  // Everything below needs /repos/{owner}/{repo}
  if (s.length < 3 || s[0] !== 'repos') {
    err(rid, res, 404, 'Not Found');
    return;
  }
  const owner = s[1] as string;
  const repoName = s[2] as string;
  const repoKey = repoKeyOf(owner, repoName);
  const repo = store.getRepo(owner, repoName);
  const rest = s.slice(3);

  // GET/PATCH/DELETE /repos/{owner}/{repo}
  if (rest.length === 0) {
    if (repo === undefined) {
      err(rid, res, 404, 'Not Found');
      return;
    }
    if (method === 'GET') {
      sendJson(rid, res, 200, repo);
      return;
    }
    if (method === 'PATCH') {
      const description = typeof body?.description === 'string' ? (body.description as string) : undefined;
      const updated = store.updateRepo(owner, repoName, { description });
      if (updated === undefined) {
        err(rid, res, 404, 'Not Found');
        return;
      }
      sendJson(rid, res, 200, updated);
      return;
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      sendNoBody(rid, res, 204);
      return;
    }
    err(rid, res, 404, 'Not Found');
    return;
  }

  // All deeper routes need the repo to exist.
  if (repo === undefined) {
    err(rid, res, 404, 'Not Found');
    return;
  }

  // GET /repos/{o}/{r}/branches  and  GET /branches/{branch}
  if (rest[0] === 'branches') {
    if (method !== 'GET') {
      err(rid, res, 404, 'Not Found');
      return;
    }
    if (rest.length === 1) {
      const out: Array<{ name: string; commit: { sha: string } }> = [];
      for (const ref of store.listRefs(repoKey)) {
        if (ref.name.startsWith('refs/heads/')) out.push({ name: ref.name.slice('refs/heads/'.length), commit: { sha: ref.oid } });
      }
      sendJson(rid, res, 200, out);
      return;
    }
    if (rest.length === 2) {
      const sha = store.getRef(repoKey, `refs/heads/${rest[1] as string}`);
      if (sha === undefined) {
        err(rid, res, 404, 'Not Found');
        return;
      }
      sendJson(rid, res, 200, { name: rest[1], commit: { sha }, protected: false });
      return;
    }
    err(rid, res, 404, 'Not Found');
    return;
  }

  // GET /repos/{o}/{r}/commits[?sha=<ref>]
  if (rest[0] === 'commits' && rest.length === 1) {
    if (method !== 'GET') {
      err(rid, res, 404, 'Not Found');
      return;
    }
    const tip = resolveRefTip(store, repoKey, query.sha, repo.default_branch);
    const out: Array<{ sha: string; commit: { message: string; author: { name: string; email: string }; committer: { name: string; email: string } } }> = [];
    if (tip !== undefined) {
      const seen = new Set<string>();
      const stack = [tip];
      while (stack.length > 0) {
        const oid = stack.pop() as string;
        if (seen.has(oid)) continue;
        seen.add(oid);
        const obj = store.getObject(repoKey, oid);
        if (obj === undefined || obj.type !== 'commit') continue;
        const c = parseCommit(obj.data);
        const authorBits = splitIdent(c.author);
        const committerBits = splitIdent(c.committer);
        out.push({
          sha: oid,
          commit: {
            message: c.message,
            author: { name: authorBits.name, email: authorBits.email },
            committer: { name: committerBits.name, email: committerBits.email },
          },
        });
        for (const p of c.parents) stack.push(p);
      }
    }
    sendJson(rid, res, 200, out);
    return;
  }

  // POST /repos/{o}/{r}/git/refs  and  GET /git/refs/heads/{branch}
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const ref = typeof body?.ref === 'string' ? (body.ref as string) : '';
      const sha = typeof body?.sha === 'string' ? (body.sha as string) : '';
      if (ref === '' || sha === '') {
        err(rid, res, 422, 'ref and sha are required');
        return;
      }
      if (!store.hasObject(repoKey, sha)) {
        err(rid, res, 422, 'Object does not exist');
        return;
      }
      if (store.getRef(repoKey, ref) !== undefined) {
        err(rid, res, 422, 'Reference already exists');
        return;
      }
      store.setRef(repoKey, ref, sha);
      sendJson(rid, res, 201, { ref, object: { sha, type: 'commit' } });
      return;
    }
    if (method === 'GET' && rest.length === 4 && rest[2] === 'heads') {
      const sha = store.getRef(repoKey, `refs/heads/${rest[3] as string}`);
      if (sha === undefined) {
        err(rid, res, 404, 'Not Found');
        return;
      }
      sendJson(rid, res, 200, { ref: `refs/heads/${rest[3] as string}`, object: { sha, type: 'commit' } });
      return;
    }
    err(rid, res, 404, 'Not Found');
    return;
  }

  // Contents: PUT/GET/DELETE /repos/{o}/{r}/contents/{path...}
  if (rest[0] === 'contents') {
    await contentsRoute(store, req, res, route, repo, repoKey, rest.slice(1));
    return;
  }

  // POST /repos/{o}/{r}/labels
  if (rest[0] === 'labels' && rest.length === 1) {
    if (method !== 'POST') {
      err(rid, res, 404, 'Not Found');
      return;
    }
    const name = typeof body?.name === 'string' ? (body.name as string) : '';
    if (name === '') {
      err(rid, res, 422, 'name is required');
      return;
    }
    const color = typeof body?.color === 'string' ? (body.color as string) : undefined;
    const description = typeof body?.description === 'string' ? (body.description as string) : undefined;
    sendJson(rid, res, 201, store.createLabel(repoKey, name, color, description));
    return;
  }

  // Issues
  if (rest[0] === 'issues') {
    await issuesRoute(store, req, res, route, repo, repoKey, rest.slice(1));
    return;
  }

  // Pulls
  if (rest[0] === 'pulls') {
    await pullsRoute(store, req, res, route, repo, repoKey, rest.slice(1));
    return;
  }

  err(rid, res, 404, 'Not Found');
}

function splitIdent(line: string): { name: string; email: string } {
  const lt = line.indexOf('<');
  const gt = line.indexOf('>');
  if (lt === -1 || gt === -1 || gt < lt) return { name: line.trim(), email: '' };
  return { name: line.slice(0, lt).trim(), email: line.slice(lt + 1, gt) };
}

// ---------------------------------------------------------------------------
// Contents routes

function contentFileBody(path: string, sha: string, contentBase64: string, size: number): Json {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return { type: 'file', encoding: 'base64', size, name, path, content: contentBase64, sha };
}

async function contentsRoute(
  store: Store,
  _req: IncomingMessage,
  res: ServerResponse,
  route: Route,
  repo: NonNullable<ReturnType<Store['getRepo']>>,
  repoKey: string,
  pathSegs: string[],
): Promise<void> {
  const rid = route.rid;
  const { method, query, body } = route;
  const path = pathSegs.join('/');
  const branch = typeof body?.branch === 'string' ? (body.branch as string) : undefined;
  const message = typeof body?.message === 'string' ? (body.message as string) : '';

  if (method === 'PUT') {
    const content = typeof body?.content === 'string' ? (body.content as string) : '';
    if (content === '') {
      err(rid, res, 422, 'content is required');
      return;
    }
    const sha = typeof body?.sha === 'string' ? (body.sha as string) : undefined;
    if (branch !== undefined && branch !== '' && branch !== repo.default_branch) {
      const r = writeFileOnRef(store, repoKey, `refs/heads/${branch}`, path, content, message, sha);
      if ('error' in r) {
        if (r.error === 'stale') err(rid, res, 409, 'sha does not match the current blob');
        else err(rid, res, 404, 'Not Found');
        return;
      }
      const blob = store.getObject(repoKey, r.blobSha);
      sendJson(rid, res, r.created ? 201 : 200, {
        content: contentFileBody(path, r.blobSha, content, blob === undefined ? 0 : blob.data.length),
        commit: { sha: r.commitSha, message: message === '' ? `Update ${path}` : message },
      });
      return;
    }
    const r = store.createOrUpdateFile(repoKey, path, content, message, sha);
    if ('error' in r) {
      if (r.error === 'stale') err(rid, res, 409, 'sha does not match the current blob');
      else err(rid, res, 404, 'Not Found');
      return;
    }
    const blob = store.getObject(repoKey, r.blobSha);
    sendJson(rid, res, r.created ? 201 : 200, {
      content: contentFileBody(path, r.blobSha, content, blob === undefined ? 0 : blob.data.length),
      commit: { sha: r.commitSha, message: message === '' ? `Update ${path}` : message },
    });
    return;
  }

  if (method === 'GET') {
    const tip = resolveRefTip(store, repoKey, query.ref, repo.default_branch);
    if (tip === undefined) {
      err(rid, res, 404, 'Not Found');
      return;
    }
    const dir = listDirOnRef(store, repoKey, tip, path);
    if (dir !== undefined) {
      sendJson(rid, res, 200, dir);
      return;
    }
    const file = readFileOnRef(store, repoKey, tip, path);
    if (file === undefined) {
      err(rid, res, 404, 'Not Found');
      return;
    }
    const blob = store.getObject(repoKey, file.sha);
    sendJson(rid, res, 200, contentFileBody(path, file.sha, file.contentBase64, blob === undefined ? 0 : blob.data.length));
    return;
  }

  if (method === 'DELETE') {
    const sha = typeof body?.sha === 'string' ? (body.sha as string) : undefined;
    const r = store.deleteFile(repoKey, path, message, sha);
    if ('error' in r) {
      err(rid, res, 404, 'Not Found');
      return;
    }
    sendJson(rid, res, 200, { commit: { sha: r.commitSha, message: message === '' ? `Delete ${path}` : message } });
    return;
  }

  err(rid, res, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// Issue routes

async function issuesRoute(
  store: Store,
  _req: IncomingMessage,
  res: ServerResponse,
  route: Route,
  repo: NonNullable<ReturnType<Store['getRepo']>>,
  repoKey: string,
  rest: string[],
): Promise<void> {
  const rid = route.rid;
  const { method, query, body } = route;

  // POST /issues  and  GET /issues
  if (rest.length === 0) {
    if (method === 'POST') {
      const title = typeof body?.title === 'string' ? (body.title as string) : '';
      const issueBody = typeof body?.body === 'string' ? (body.body as string) : undefined;
      const labels = Array.isArray(body?.labels) ? (body.labels as unknown[]).filter((l): l is string => typeof l === 'string') : [];
      const r = store.createIssue(repoKey, title, issueBody, labels);
      if ('error' in r) {
        err(rid, res, 422, `Label '${r.label}' does not exist`);
        return;
      }
      sendJson(rid, res, 201, r.issue);
      return;
    }
    if (method === 'GET') {
      const state = query.state === 'closed' ? 'closed' : query.state === 'all' ? 'all' : 'open';
      let list = store.listIssues(repoKey, state);
      if (query.sort === 'created') {
        if (query.direction === 'desc') list = [...list].reverse();
      }
      const { page } = paginate(list, query);
      sendJson(rid, res, 200, page);
      return;
    }
    err(rid, res, 404, 'Not Found');
    return;
  }

  const number = Number.parseInt(rest[0] as string, 10);
  if (!Number.isInteger(number) || number < 1) {
    err(rid, res, 404, 'Not Found');
    return;
  }

  // POST/GET /issues/{n}/comments
  if (rest.length === 2 && rest[1] === 'comments') {
    const issue = store.getIssue(repoKey, number);
    if (issue === undefined) {
      err(rid, res, 404, 'Not Found');
      return;
    }
    if (method === 'POST') {
      const text = typeof body?.body === 'string' ? (body.body as string) : '';
      const comment = addIssueComment(issue, text, store.nowIso());
      issue.comments = listIssueComments(issue).length;
      sendJson(rid, res, 201, { id: comment.id, body: comment.body, created_at: comment.created_at, user: store.viewer });
      return;
    }
    if (method === 'GET') {
      sendJson(
        store,
        res,
        200,
        listIssueComments(issue).map((c) => ({ id: c.id, body: c.body, created_at: c.created_at, user: store.viewer })),
      );
      return;
    }
    err(rid, res, 404, 'Not Found');
    return;
  }

  if (rest.length !== 1) {
    err(rid, res, 404, 'Not Found');
    return;
  }

  // GET /issues/{n} — the read workload: direct lookups, one stringify.
  if (method === 'GET') {
    const issue = store.getIssue(repoKey, number);
    if (issue === undefined) {
      err(rid, res, 404, 'Not Found');
      return;
    }
    sendJson(rid, res, 200, issue);
    return;
  }

  // PATCH /issues/{n}
  if (method === 'PATCH') {
    const issue = store.getIssue(repoKey, number);
    if (issue === undefined) {
      err(rid, res, 404, 'Not Found');
      return;
    }
    if (typeof body?.title === 'string') issue.title = body.title as string;
    if (typeof body?.body === 'string') issue.body = body.body as string;
    if (body?.state === 'closed') {
      issue.state = 'closed';
      issue.closed_at = store.nowIso();
    } else if (body?.state === 'open') {
      issue.state = 'open';
      issue.closed_at = null;
    }
    issue.updated_at = store.nowIso();
    sendJson(rid, res, 200, issue);
    return;
  }

  err(rid, res, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// Pull routes

async function pullsRoute(
  store: Store,
  _req: IncomingMessage,
  res: ServerResponse,
  route: Route,
  _repo: NonNullable<ReturnType<Store['getRepo']>>,
  repoKey: string,
  rest: string[],
): Promise<void> {
  const rid = route.rid;
  const { method, query, body } = route;

  // POST /pulls  and  GET /pulls
  if (rest.length === 0) {
    if (method === 'POST') {
      const title = typeof body?.title === 'string' ? (body.title as string) : '';
      const pullBody = typeof body?.body === 'string' ? (body.body as string) : undefined;
      const head = typeof body?.head === 'string' ? (body.head as string) : '';
      const base = typeof body?.base === 'string' ? (body.base as string) : '';
      const r = store.createPull(repoKey, title, pullBody, head, base);
      if ('error' in r) {
        err(rid, res, 422, r.error === 'head' ? `Head ref '${head}' does not exist` : `Base ref '${base}' does not exist`);
        return;
      }
      sendJson(rid, res, 201, r.pull);
      return;
    }
    if (method === 'GET') {
      const state = query.state === 'closed' ? 'closed' : query.state === 'all' ? 'all' : 'open';
      const { page } = paginate(store.listPulls(repoKey, state), query);
      sendJson(rid, res, 200, page);
      return;
    }
    err(rid, res, 404, 'Not Found');
    return;
  }

  const number = Number.parseInt(rest[0] as string, 10);
  if (!Number.isInteger(number) || number < 1) {
    err(rid, res, 404, 'Not Found');
    return;
  }

  // GET /pulls/{n}/files
  if (rest.length === 2 && rest[1] === 'files') {
    if (method !== 'GET') {
      err(rid, res, 404, 'Not Found');
      return;
    }
    const pull = store.getPull(repoKey, number);
    if (pull === undefined) {
      err(rid, res, 404, 'Not Found');
      return;
    }
    const files = pullChangedFiles(store, repoKey, pull.base.sha, pull.head.sha);
    sendJson(rid, res, 200, files);
    return;
  }

  // PUT /pulls/{n}/merge
  if (rest.length === 2 && rest[1] === 'merge') {
    if (method !== 'PUT') {
      err(rid, res, 404, 'Not Found');
      return;
    }
    const r = store.mergePull(repoKey, number);
    if ('error' in r) {
      if (r.error === 'not_found') err(rid, res, 404, 'Not Found');
      else if (r.error === 'conflict') err(rid, res, 405, 'Merge conflict');
      else err(rid, res, 405, 'Pull request is already merged');
      return;
    }
    sendJson(rid, res, 200, { sha: r.sha, merged: true, message: r.message });
    return;
  }

  if (rest.length !== 1) {
    err(rid, res, 404, 'Not Found');
    return;
  }

  // GET /pulls/{n}
  if (method === 'GET') {
    const pull = store.getPull(repoKey, number);
    if (pull === undefined) {
      err(rid, res, 404, 'Not Found');
      return;
    }
    sendJson(rid, res, 200, pull);
    return;
  }

  err(rid, res, 404, 'Not Found');
}
