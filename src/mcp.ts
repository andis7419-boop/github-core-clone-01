// MCP at /mcp (DESIGN.md section 7): JSON-RPC 2.0 over Streamable HTTP,
// plain application/json answers. Both protocol paths are served:
//   - revision 2026-07-28: server/discover answers supportedVersions;
//   - handshake 2025-11-25 or earlier: initialize + notifications/initialized,
//     with a fixed Mcp-Session-Id of "session-1" (never random).
// Original work; no wall clock, no unseeded randomness, no filesystem access.
// Handler contract (see NOTES.md): server.ts calls
//   handleMcp(store, req, res, { token })
// for POST /mcp (and DELETE /mcp for session close). The handler sends the
// whole response itself and never throws to the caller.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';
import type { HandlerContext } from './rest.ts';

type Json = Record<string, unknown>;

const SERVER_NAME = 'github-core-clone-01';
const SERVER_VERSION = '1.0.0';
const SESSION_ID = 'session-1';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

// The tool list is STATIC: built once at module load, so two tools/list calls
// answer byte-for-byte identical tools arrays.
const TOOLS: Json[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const CANONICAL = ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request'];

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function matchTool(name: string): string | null {
  const wanted = normalizeName(name);
  for (const canonical of CANONICAL) {
    const norm = normalizeName(canonical);
    if (wanted === norm) return canonical;
    if (wanted.length > norm.length && wanted.endsWith(norm)) return canonical;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Argument mapping: the suite maps its documented names onto the schema's
// property names, but accept synonyms and a full_name too, defensively.

const SYNONYMS: Record<string, string[]> = {
  owner: ['owner', 'owner_login', 'org', 'organization', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name'],
  repo: ['repo', 'repository', 'repository_name', 'repo_name', 'project'],
  name: ['name', 'repo', 'repository', 'repository_name', 'repo_name'],
  title: ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject'],
  body: ['body', 'issue_body', 'description', 'content', 'text'],
  head: ['head', 'head_ref', 'head_branch', 'source_branch', 'from_branch', 'branch'],
  base: ['base', 'base_ref', 'base_branch', 'target_branch', 'into_branch'],
  pull_number: ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index'],
  description: ['description', 'about', 'summary', 'body'],
  private: ['private', 'is_private'],
  state: ['state', 'status'],
};

function pickArg(args: Record<string, unknown>, key: string): unknown {
  const byNorm = new Map<string, unknown>();
  for (const k of Object.keys(args)) byNorm.set(normalizeName(k), args[k]);
  for (const synonym of SYNONYMS[key] ?? [key]) {
    const v = byNorm.get(normalizeName(synonym));
    if (v !== undefined) return v;
  }
  return undefined;
}

function splitFullName(args: Record<string, unknown>): { owner: string | undefined; repo: string | undefined } {
  const full = pickArg(args, 'full_name');
  const raw = typeof full === 'string' ? full : typeof args.full_name === 'string' ? (args.full_name as string) : undefined;
  if (raw === undefined) return { owner: undefined, repo: undefined };
  const slash = raw.indexOf('/');
  if (slash === -1) return { owner: undefined, repo: undefined };
  return { owner: raw.slice(0, slash), repo: raw.slice(slash + 1) };
}

function ownerRepo(args: Record<string, unknown>): { owner: string | undefined; repo: string | undefined } {
  let owner = pickArg(args, 'owner');
  let repo = pickArg(args, 'repo');
  if ((owner === undefined || repo === undefined) && args.full_name !== undefined) {
    const split = splitFullName(args);
    if (owner === undefined) owner = split.owner;
    if (repo === undefined) repo = split.repo;
  }
  return {
    owner: typeof owner === 'string' ? owner : undefined,
    repo: typeof repo === 'string' ? repo : undefined,
  };
}

// ---------------------------------------------------------------------------
// Tool dispatch. Every tool returns { text, isError }; the store is the same
// one REST and GraphQL use, so objects and ids are identical across surfaces.

function toolResult(text: string, isError: boolean): Json {
  return { content: [{ type: 'text', text }], isError };
}

function callTool(store: Store, canonical: string, args: Record<string, unknown>): Json {
  if (canonical === 'create_repo') {
    const name = pickArg(args, 'name');
    if (typeof name !== 'string' || name === '') return toolResult('Missing required argument: name', true);
    const description = pickArg(args, 'description');
    const repo = store.createRepo(name, typeof description === 'string' ? description : undefined);
    if (repo === null) return toolResult(`Repository '${name}' already exists`, true);
    const isPrivate = pickArg(args, 'private');
    (repo as unknown as { private: boolean }).private = isPrivate === true;
    return toolResult(JSON.stringify(repo), false);
  }

  if (canonical === 'get_repo') {
    const { owner, repo } = ownerRepo(args);
    if (owner === undefined || repo === undefined) return toolResult('Missing required argument: owner or repo', true);
    const found = store.getRepo(owner, repo);
    if (found === undefined) return toolResult(`Repository '${owner}/${repo}' not found`, true);
    return toolResult(JSON.stringify(found), false);
  }

  if (canonical === 'create_issue') {
    const { owner, repo } = ownerRepo(args);
    const title = pickArg(args, 'title');
    if (owner === undefined || repo === undefined || typeof title !== 'string' || title === '') {
      return toolResult('Missing required argument: owner, repo, or title', true);
    }
    const repoKey = `${owner}/${repo}`;
    if (store.getRepo(owner, repo) === undefined) return toolResult(`Repository '${repoKey}' not found`, true);
    const body = pickArg(args, 'body');
    const r = store.createIssue(repoKey, title, typeof body === 'string' ? body : undefined, []);
    if ('error' in r) return toolResult(`Label '${r.label}' does not exist`, true);
    return toolResult(JSON.stringify(r.issue), false);
  }

  if (canonical === 'list_issues') {
    const { owner, repo } = ownerRepo(args);
    if (owner === undefined || repo === undefined) return toolResult('Missing required argument: owner or repo', true);
    const repoKey = `${owner}/${repo}`;
    if (store.getRepo(owner, repo) === undefined) return toolResult(`Repository '${repoKey}' not found`, true);
    const state = pickArg(args, 'state');
    const list = store.listIssues(repoKey, state === 'closed' ? 'closed' : state === 'all' ? 'all' : 'open');
    return toolResult(JSON.stringify(list), false);
  }

  if (canonical === 'create_pull_request') {
    const { owner, repo } = ownerRepo(args);
    const title = pickArg(args, 'title');
    const head = pickArg(args, 'head');
    const base = pickArg(args, 'base');
    if (owner === undefined || repo === undefined || typeof title !== 'string' || title === '' || typeof head !== 'string' || head === '' || typeof base !== 'string' || base === '') {
      return toolResult('Missing required argument: owner, repo, title, head, or base', true);
    }
    const repoKey = `${owner}/${repo}`;
    const body = pickArg(args, 'body');
    const r = store.createPull(repoKey, title, typeof body === 'string' ? body : undefined, head, base);
    if ('error' in r) return toolResult(r.error === 'head' ? `Head ref '${head}' does not exist` : `Base ref '${base}' does not exist`, true);
    return toolResult(JSON.stringify(r.pull), false);
  }

  if (canonical === 'merge_pull_request') {
    const { owner, repo } = ownerRepo(args);
    const num = pickArg(args, 'pull_number');
    const number = typeof num === 'number' ? num : typeof num === 'string' ? Number.parseInt(num, 10) : NaN;
    if (owner === undefined || repo === undefined || !Number.isInteger(number)) {
      return toolResult('Missing required argument: owner, repo, or pull_number', true);
    }
    const r = store.mergePull(`${owner}/${repo}`, number);
    if ('error' in r) {
      if (r.error === 'not_found') return toolResult(`Pull request #${number} not found`, true);
      if (r.error === 'conflict') return toolResult(`Pull request #${number} has a merge conflict`, true);
      return toolResult(`Pull request #${number} is already merged`, true);
    }
    return toolResult(JSON.stringify({ sha: r.sha, merged: true, message: r.message, number }), false);
  }

  return toolResult(`Unknown tool: ${canonical}`, true);
}

// ---------------------------------------------------------------------------
// Handler

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function extractId(text: string): unknown {
  const m = /"id"\s*:\s*("[^"]*"|-?\d+)/.exec(text);
  if (m === null) return null;
  const raw = m[1] as string;
  if (raw.startsWith('"')) return raw.slice(1, -1);
  return Number.parseInt(raw, 10);
}

export async function handleMcp(store: Store, req: IncomingMessage, res: ServerResponse, ctx: HandlerContext): Promise<void> {
  const rid = ctx.requestId ?? store.nextRequestId();
  const token = ctx.token !== undefined && ctx.token !== '' ? ctx.token : process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const method = req.method ?? 'GET';

  // Session close (best-effort DELETE from the client): no body, no error.
  if (method === 'DELETE') {
    res.writeHead(204, { 'x-github-request-id': rid });
    res.end();
    return;
  }
  if (method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json', 'x-github-request-id': rid });
    res.end(JSON.stringify({ message: 'Method Not Allowed' }));
    return;
  }

  const sendRpc = (status: number, payload: Json, sessionHeader: boolean): void => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-github-request-id': rid,
    };
    if (sessionHeader) headers['mcp-session-id'] = SESSION_ID;
    res.writeHead(status, headers);
    res.end(JSON.stringify(payload));
  };

  // Auth is decided before any tool exists: no token is a 401. server.ts
  // already enforces this before dispatching; this is the second line.
  if (token !== '' && req.headers.authorization !== `Bearer ${token}`) {
    sendRpc(401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }, false);
    return;
  }

  let text = '';
  try {
    text = await readBody(req);
  } catch {
    sendRpc(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, false);
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Non-JSON body: HTTP 400 with JSON-RPC -32700, echoing the id if one
    // can be read out of the broken body.
    sendRpc(400, { jsonrpc: '2.0', id: extractId(text), error: { code: -32700, message: 'Parse error' } }, false);
    return;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    sendRpc(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }, false);
    return;
  }

  const body = parsed as Record<string, unknown>;
  const rpcMethod = typeof body.method === 'string' ? body.method : '';
  const hasId = 'id' in body && body.id !== undefined;
  const id: unknown = hasId ? body.id : null;

  // Notifications carry no id and get no JSON-RPC response.
  if (!hasId) {
    res.writeHead(202, { 'x-github-request-id': rid });
    res.end();
    return;
  }

  const result = (value: Json, sessionHeader = false): void => {
    sendRpc(200, { jsonrpc: '2.0', id, result: value }, sessionHeader);
  };
  const rpcError = (code: number, message: string): void => {
    sendRpc(200, { jsonrpc: '2.0', id, error: { code, message } }, false);
  };

  const params = (typeof body.params === 'object' && body.params !== null ? body.params : {}) as Record<string, unknown>;
  const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };

  if (rpcMethod === 'server/discover') {
    result({
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo,
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    });
    return;
  }

  if (rpcMethod === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = LEGACY_VERSIONS.includes(requested) ? requested : '2025-11-25';
    result(
      {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo,
      },
      true,
    );
    return;
  }

  if (rpcMethod === 'ping') {
    result({});
    return;
  }

  if (rpcMethod === 'tools/list') {
    result({ tools: TOOLS });
    return;
  }

  if (rpcMethod === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const canonical = matchTool(name);
    if (canonical === null) {
      rpcError(-32602, `Unknown tool: ${name}`);
      return;
    }
    const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
    let outcome: Json;
    try {
      outcome = callTool(store, canonical, args);
    } catch (e) {
      outcome = toolResult(e instanceof Error ? e.message : 'Tool call failed', true);
    }
    result(outcome);
    return;
  }

  rpcError(-32601, `Method not found: ${rpcMethod}`);
}
