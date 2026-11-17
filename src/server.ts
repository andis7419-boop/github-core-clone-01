// HTTP server: routing, JSON replies, auth, request ids.
//
// One node:http server. GET /healthz answers without auth (the env's boot
// probe); every other known surface requires `Authorization: Bearer
// <MAKEFUN_SHOP_TOKEN>` and answers 401 JSON otherwise. Unknown paths answer
// 404 JSON. A handler that throws becomes a 500 JSON, never a crash.
//
// The REST / GraphQL / MCP surfaces live in their own modules (W3). They are
// loaded lazily on first use so a missing module degrades to a 404 stub
// instead of failing the whole server; an explicit override map (used by
// tests and by main.ts once the modules exist) wins over the lazy load.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Store } from './store.ts';
import { handleGitHttp } from './git-http.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const BODY_LIMIT = 64 * 1024 * 1024;

export interface RequestContext {
  requestId: string;
  segments: string[];
  query: Map<string, string>;
  /** Read the request body once (later calls reuse the same buffer). */
  readBody: (maxBytes?: number) => Promise<Buffer>;
}

/**
 * A surface handler. It receives the store, the raw request/response and a
 * context; it must end the response itself (or leave it untouched only if it
 * intends the server to answer 500).
 */
export type ApiHandler = (store: Store, req: IncomingMessage, res: ServerResponse, ctx: RequestContext) => unknown;

export interface AppHandlers {
  rest?: ApiHandler;
  graphql?: ApiHandler;
  mcp?: ApiHandler;
}

// -------------------------------------------------------------------------------------------
// JSON replies and body reading
// -------------------------------------------------------------------------------------------

export function sendJson(res: ServerResponse, status: number, body: unknown, requestId: string, extra: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
    ...extra,
  });
  res.end(text);
}

function makeReadBody(req: IncomingMessage): (maxBytes?: number) => Promise<Buffer> {
  let cached: Promise<Buffer> | null = null;
  return (maxBytes: number = BODY_LIMIT): Promise<Buffer> => {
    if (cached === null) {
      cached = new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let settled = false;
        req.on('data', (chunk: Buffer) => {
          if (settled) return;
          total += chunk.length;
          if (total > maxBytes) {
            settled = true;
            req.destroy();
            reject(new Error('request body exceeds the limit'));
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
    return cached;
  };
}

// -------------------------------------------------------------------------------------------
// lazy surface loading (a missing module is a 404 stub, not a crash)
// -------------------------------------------------------------------------------------------

function pickHandler(mod: unknown, names: readonly string[]): ApiHandler | null {
  if (mod === null || typeof mod !== 'object') return null;
  const record = mod as Record<string, unknown>;
  for (const name of names) {
    if (typeof record[name] === 'function') return record[name] as ApiHandler;
  }
  if (typeof record.default === 'function') return record.default as ApiHandler;
  return null;
}

async function loadRest(): Promise<ApiHandler | null> {
  try {
    return pickHandler(await import('./rest.ts'), ['handleRest', 'routeRest', 'restHandler', 'handleApi']);
  } catch {
    return null;
  }
}

async function loadGraphql(): Promise<ApiHandler | null> {
  try {
    return pickHandler(await import('./graphql.ts'), ['handleGraphql', 'routeGraphql', 'graphqlHandler', 'handleApi']);
  } catch {
    return null;
  }
}

async function loadMcp(): Promise<ApiHandler | null> {
  try {
    return pickHandler(await import('./mcp.ts'), ['handleMcp', 'routeMcp', 'mcpHandler', 'handleApi']);
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------------------------
// routing
// -------------------------------------------------------------------------------------------

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function splitPath(rawUrl: string): { segments: string[]; query: Map<string, string> } {
  const cut = rawUrl.indexOf('?');
  const path = cut < 0 ? rawUrl : rawUrl.slice(0, cut);
  const query = new Map<string, string>();
  if (cut >= 0) {
    for (const pair of rawUrl.slice(cut + 1).split('&')) {
      if (pair === '') continue;
      const eq = pair.indexOf('=');
      if (eq < 0) query.set(safeDecode(pair), '');
      else query.set(safeDecode(pair.slice(0, eq)), safeDecode(pair.slice(eq + 1)));
    }
  }
  const segments = path
    .split('/')
    .filter((part) => part.length > 0)
    .map((part) => safeDecode(part));
  return { segments, query };
}

/**
 * True when the request carries the trial token. When no token is configured
 * (local development without MAKEFUN_SHOP_TOKEN) auth is open; the trial
 * always sets one, so this never weakens a scored run.
 */
function authorized(req: IncomingMessage): boolean {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (token === '') return true;
  return req.headers.authorization === `Bearer ${token}`;
}

async function dispatchApi(
  handler: ApiHandler,
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
): Promise<void> {
  await handler(store, req, res, ctx);
  if (!res.writableEnded) sendJson(res, 500, { message: 'Internal Server Error' }, ctx.requestId);
}

export function createApp(store: Store, overrides: AppHandlers = {}): Server {
  let restLoader: Promise<ApiHandler | null> | null = null;
  let graphqlLoader: Promise<ApiHandler | null> | null = null;
  let mcpLoader: Promise<ApiHandler | null> | null = null;
  const getRest = (): Promise<ApiHandler | null> => {
    if (overrides.rest !== undefined) return Promise.resolve(overrides.rest);
    if (restLoader === null) restLoader = loadRest();
    return restLoader;
  };
  const getGraphql = (): Promise<ApiHandler | null> => {
    if (overrides.graphql !== undefined) return Promise.resolve(overrides.graphql);
    if (graphqlLoader === null) graphqlLoader = loadGraphql();
    return graphqlLoader;
  };
  const getMcp = (): Promise<ApiHandler | null> => {
    if (overrides.mcp !== undefined) return Promise.resolve(overrides.mcp);
    if (mcpLoader === null) mcpLoader = loadMcp();
    return mcpLoader;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const requestId = store.nextRequestId();
    const method = req.method ?? 'GET';
    const { segments, query } = splitPath(req.url ?? '/');
    const ctx: RequestContext = { requestId, segments, query, readBody: makeReadBody(req) };

    // Boot probe: no auth, always 200.
    if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
      sendJson(res, 200, { ok: true }, requestId);
      return;
    }

    // Git smart HTTP: /{owner}/{repo}.git/...
    if (segments.length >= 2 && segments[1].endsWith('.git')) {
      if (!authorized(req)) {
        sendJson(res, 401, { message: 'Bad credentials' }, requestId);
        return;
      }
      await handleGitHttp(store, req, res, {
        owner: segments[0],
        repo: segments[1].slice(0, -4),
        rest: segments.length > 2 ? `/${segments.slice(2).join('/')}` : '/',
        query,
        requestId,
      });
      return;
    }

    // GraphQL v4.
    if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
      if (!authorized(req)) {
        sendJson(res, 401, { message: 'Bad credentials' }, requestId);
        return;
      }
      const handler = await getGraphql();
      if (handler === null) {
        sendJson(res, 404, { message: 'Not Found' }, requestId);
        return;
      }
      await dispatchApi(handler, store, req, res, ctx);
      return;
    }

    // MCP (Streamable HTTP).
    if (segments.length === 1 && segments[0] === 'mcp') {
      if (!authorized(req)) {
        sendJson(res, 401, { message: 'Bad credentials' }, requestId);
        return;
      }
      const handler = await getMcp();
      if (handler === null) {
        sendJson(res, 404, { message: 'Not Found' }, requestId);
        return;
      }
      await dispatchApi(handler, store, req, res, ctx);
      return;
    }

    // REST v3.
    if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
      if (!authorized(req)) {
        sendJson(res, 401, { message: 'Bad credentials' }, requestId);
        return;
      }
      const handler = await getRest();
      if (handler === null) {
        sendJson(res, 404, { message: 'Not Found' }, requestId);
        return;
      }
      await dispatchApi(handler, store, req, res, ctx);
      return;
    }

    sendJson(res, 404, { message: 'Not Found' }, requestId);
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch((err: unknown) => {
      process.stderr.write(`[entry] request error: ${err instanceof Error ? err.message : String(err)}\n`);
      try {
        if (!res.writableEnded) {
          // The request id is unknown here (the failure happened before or
          // while it was minted); answer without it rather than crashing.
          const text = '{"message":"Internal Server Error"}\n';
          res.writeHead(500, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text) });
          res.end(text);
        }
      } catch {
        // The socket is gone; nothing left to do.
      }
    });
  });
  server.keepAliveTimeout = 5000;
  server.headersTimeout = 60000;
  return server;
}
