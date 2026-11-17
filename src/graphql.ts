// GraphQL v4 at /api/graphql (DESIGN.md section 6).
// A tiny executor for exactly the documents the suite sends (see
// checks-graphql.ts): repository/issue/pullRequest reads, the create/close/
// merge/addComment mutations, node(id:), __type introspection, search, and
// batched operation arrays. No GraphQL library; a hand-written tokenizer and
// recursive-descent parser. Original work; no wall clock, no unseeded randomness, no filesystem access.
// Handler contract (see NOTES.md): server.ts calls
//   handleGraphql(store, req, res, { token })
// for POST /api/graphql. The handler sends the whole response itself.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';
import { addIssueComment, pullChangedFiles } from './rest.ts';
import type { HandlerContext } from './rest.ts';

type Json = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Tokenizer

interface Token {
  kind: 'name' | 'string' | 'int' | 'punct' | 'spread';
  value: string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():[]!=$'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let out = '';
      i += 1;
      while (i < n && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < n) {
          const e = src[i + 1] as string;
          if (e === 'n') out += '\n';
          else if (e === 't') out += '\t';
          else if (e === 'r') out += '\r';
          else if (e === 'u' && i + 5 < n) {
            out += String.fromCharCode(Number.parseInt(src.slice(i + 2, i + 6), 16));
            i += 4;
          } else out += e;
          i += 2;
        } else {
          out += src[i] as string;
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value: out });
      continue;
    }
    if ((c >= '0' && c <= '9') || (c === '-' && src[i + 1] !== undefined && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < n && ((src[j] as string) >= '0' && (src[j] as string) <= '9')) j += 1;
      tokens.push({ kind: 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_') {
      let j = i;
      while (j < n) {
        const ch = src[j] as string;
        if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '_') j += 1;
        else break;
      }
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    // Unknown character: skip it rather than failing the whole document.
    i += 1;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser: a minimal AST for the suite's documents.

interface ValueNode {
  kind: 'variable' | 'string' | 'int' | 'boolean' | 'null' | 'enum' | 'list' | 'object';
  value: unknown;
}

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | undefined;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[] | undefined;
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | undefined;
  name: string | undefined;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface OperationNode {
  kind: 'query' | 'mutation';
  name: string | undefined;
  variables: Array<{ name: string; defaultValue: ValueNode | undefined }>;
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token | undefined {
    return this.tokens[this.pos++];
  }
  private expectPunct(v: string): void {
    const t = this.next();
    if (t === undefined || t.kind !== 'punct' || t.value !== v) throw new Error(`expected ${v}`);
  }
  private acceptPunct(v: string): boolean {
    const t = this.peek();
    if (t !== undefined && t.kind === 'punct' && t.value === v) {
      this.pos += 1;
      return true;
    }
    return false;
  }
  private expectName(): string {
    const t = this.next();
    if (t === undefined || t.kind !== 'name') throw new Error('expected name');
    return t.value;
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentNode> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek() !== undefined) {
      const t = this.peek() as Token;
      if (t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName(); // 'on'
        const typeCondition = this.expectName();
        const selections = this.parseSelectionSet();
        fragments.set(name, { kind: 'fragment', typeCondition, name, selections });
        continue;
      }
      operations.push(this.parseOperation());
    }
    return { operations, fragments };
  }

  private parseOperation(): OperationNode {
    let kind: 'query' | 'mutation' = 'query';
    const t = this.peek();
    if (t !== undefined && t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      kind = this.next()?.value as 'query' | 'mutation';
    }
    let name: string | undefined;
    const after = this.peek();
    if (after !== undefined && after.kind === 'name') name = this.next()?.value;
    const variables: Array<{ name: string; defaultValue: ValueNode | undefined }> = [];
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseType();
        let defaultValue: ValueNode | undefined;
        if (this.acceptPunct('=')) defaultValue = this.parseValue();
        variables.push({ name: varName, defaultValue });
      }
    }
    const selections = this.parseSelectionSet();
    return { kind, name, variables, selections };
  }

  private parseType(): void {
    if (this.acceptPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.acceptPunct('!');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.acceptPunct('}')) {
      if (this.peek() === undefined) throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    const t = this.peek();
    if (t !== undefined && t.kind === 'spread') {
      this.next();
      const next = this.peek();
      if (next !== undefined && next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'fragment', typeCondition, name: undefined, selections: this.parseSelectionSet() };
      }
      if (next !== undefined && next.kind === 'name') {
        return { kind: 'fragment', typeCondition: undefined, name: this.next()?.value, selections: [] };
      }
      return { kind: 'fragment', typeCondition: undefined, name: undefined, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let name = first;
    let alias: string | undefined;
    if (this.acceptPunct(':')) {
      alias = first;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    let selections: SelectionNode[] | undefined;
    const peek = this.peek();
    if (peek !== undefined && peek.kind === 'punct' && peek.value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selections };
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t === undefined) throw new Error('unexpected end of document');
    if (t.kind === 'punct' && t.value === '$') return { kind: 'variable', value: this.expectName() };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: Number.parseInt(t.value, 10) };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: t.value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const list: ValueNode[] = [];
      while (!this.acceptPunct(']')) list.push(this.parseValue());
      return { kind: 'list', value: list };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const obj: Array<{ name: string; value: ValueNode }> = [];
      while (!this.acceptPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        obj.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', value: obj };
    }
    throw new Error(`unexpected token ${t.value}`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': {
      const v = variables[node.value as string];
      return v === undefined ? null : v;
    }
    case 'string':
    case 'int':
    case 'boolean':
    case 'null':
    case 'enum':
      return node.value;
    case 'list':
      return (node.value as ValueNode[]).map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const entry of node.value as Array<{ name: string; value: ValueNode }>) out[entry.name] = resolveValue(entry.value, variables);
      return out;
    }
  }
}

function resolveArgs(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------------------
// Executor

/** A typed value the executor can recurse into: __t is the GraphQL type name. */
interface GNode {
  __t: string;
  __d: unknown;
}

function isGNode(v: unknown): v is GNode {
  return typeof v === 'object' && v !== null && '__t' in (v as Record<string, unknown>);
}

interface Ctx {
  store: Store;
  errors: Array<{ message: string }>;
  fragments: Map<string, FragmentNode>;
}

function b64encode(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}
function b64decode(s: string): string | null {
  try {
    return Buffer.from(s, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function encodeCursor(n: number): string {
  return b64encode(`cursor:${n}`);
}
function decodeCursor(s: string): number | null {
  const text = b64decode(s);
  if (text === null || !text.startsWith('cursor:')) return null;
  const n = Number.parseInt(text.slice('cursor:'.length), 10);
  return Number.isInteger(n) ? n : null;
}

function repoNode(repo: NonNullable<ReturnType<Store['getRepo']>>): GNode {
  return { __t: 'Repository', __d: repo };
}
function issueNode(repoKey: string, issue: NonNullable<ReturnType<Store['getIssue']>>): GNode {
  return { __t: 'Issue', __d: { repoKey, issue } };
}
function pullNode(repoKey: string, pull: NonNullable<ReturnType<Store['getPull']>>): GNode {
  return { __t: 'PullRequest', __d: { repoKey, pull } };
}

// --- global-id helpers: node_id is base64("<Type>:<numeric id>") ---

function decodeGlobalId(id: string): { type: string; num: number } | null {
  const text = b64decode(id);
  if (text === null) return null;
  const colon = text.indexOf(':');
  if (colon === -1) return null;
  const num = Number.parseInt(text.slice(colon + 1), 10);
  if (!Number.isInteger(num)) return null;
  return { type: text.slice(0, colon), num };
}

function findRepoByGlobalId(store: Store, id: string): GNode | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.type !== 'Repository') return null;
  for (const repo of store.listViewerRepos()) {
    if (repo.id === decoded.num) return repoNode(repo);
  }
  return null;
}

function findIssueByGlobalId(store: Store, id: string): GNode | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.type !== 'Issue') return null;
  for (const repo of store.listViewerRepos()) {
    const repoKey = `${repo.owner.login}/${repo.name}`;
    for (const issue of store.listIssues(repoKey, 'all')) {
      if (issue.id === decoded.num) return issueNode(repoKey, issue);
    }
  }
  return null;
}

function findPullByGlobalId(store: Store, id: string): GNode | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.type !== 'PullRequest') return null;
  for (const repo of store.listViewerRepos()) {
    const repoKey = `${repo.owner.login}/${repo.name}`;
    for (const pull of store.listPulls(repoKey, 'all')) {
      if (pull.id === decoded.num) return pullNode(repoKey, pull);
    }
  }
  return null;
}

// --- introspection tables (the fields gh feature-detects, plus a few extras) ---

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'closedAt', 'repository'],
  PullRequest: ['id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'body', 'headRef', 'baseRef', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt', 'updatedAt', 'defaultBranch'],
  User: ['id', 'login', 'name', 'email'],
  IssueConnection: ['nodes', 'totalCount', 'pageInfo'],
  PullRequestConnection: ['nodes', 'totalCount', 'pageInfo'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

// --- connections ---

function issuesConnection(store: Store, repoKey: string, args: Record<string, unknown>): GNode {
  let list = store.listIssues(repoKey, 'all');
  const states = args.states;
  if (Array.isArray(states)) {
    const wanted = new Set(states.map((s) => String(s)));
    list = list.filter((i) => wanted.has(i.state.toUpperCase()));
  }
  const orderBy = args.orderBy as Record<string, unknown> | undefined;
  const desc = orderBy !== undefined && orderBy.direction === 'DESC';
  list = [...list].sort((a, b) => (desc ? b.number - a.number : a.number - b.number));
  if (typeof args.after === 'string' && args.after !== '') {
    const n = decodeCursor(args.after);
    if (n !== null) list = list.filter((i) => i.number > n);
  }
  const total = list.length;
  const first = typeof args.first === 'number' ? args.first : total;
  const nodes = list.slice(0, first);
  return {
    __t: 'IssueConnection',
    __d: {
      nodes: nodes.map((i) => issueNode(repoKey, i)),
      totalCount: total,
      pageInfo: { hasNextPage: list.length > first, endCursor: nodes.length === 0 ? null : encodeCursor(nodes[nodes.length - 1]!.number) },
    },
  };
}

function pullRequestsConnection(store: Store, repoKey: string, args: Record<string, unknown>): GNode {
  const list = store.listPulls(repoKey, 'open');
  const first = typeof args.first === 'number' ? args.first : list.length;
  const nodes = list.slice(0, first);
  return {
    __t: 'PullRequestConnection',
    __d: {
      nodes: nodes.map((p) => pullNode(repoKey, p)),
      totalCount: list.length,
      pageInfo: { hasNextPage: list.length > first, endCursor: null },
    },
  };
}

function pullFilesConnection(store: Store, repoKey: string, pull: NonNullable<ReturnType<Store['getPull']>>, args: Record<string, unknown>): GNode {
  const files = pullChangedFiles(store, repoKey, pull.base.sha, pull.head.sha);
  const first = typeof args.first === 'number' ? args.first : files.length;
  const nodes = files.slice(0, first).map((f) => ({ __t: 'PullRequestChangedFile', __d: { path: f.filename } }));
  return { __t: 'PullRequestChangedFileConnection', __d: { nodes, totalCount: files.length } };
}

// --- field resolution ---

function resolveField(ctx: Ctx, typeName: string, field: FieldNode, data: unknown, variables: Record<string, unknown>): unknown {
  const store = ctx.store;
  const args = resolveArgs(field, variables);
  const name = field.name;

  if (name === '__typename') return typeName;

  if (typeName === 'Query') {
    if (name === 'viewer') return { __t: 'User', __d: store.viewer };
    if (name === 'repository') {
      const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === undefined ? null : repoNode(repo);
    }
    if (name === 'node') {
      const id = String(args.id ?? '');
      return findRepoByGlobalId(store, id) ?? findIssueByGlobalId(store, id) ?? findPullByGlobalId(store, id) ?? null;
    }
    if (name === 'search') {
      const q = String(args.query ?? '').toLowerCase();
      const first = typeof args.first === 'number' ? args.first : 10;
      const nodes: GNode[] = [];
      for (const repo of store.listViewerRepos()) {
        const repoKey = `${repo.owner.login}/${repo.name}`;
        for (const issue of store.listIssues(repoKey, 'all')) {
          const hay = `${issue.title} ${issue.body ?? ''}`.toLowerCase();
          if (q === '' || hay.includes(q)) nodes.push(issueNode(repoKey, issue));
          if (nodes.length >= first) break;
        }
        if (nodes.length >= first) break;
      }
      return { __t: 'SearchResultItemConnection', __d: { nodes, issueCount: nodes.length } };
    }
    if (name === '__type') {
      const typeNameArg = String(args.name ?? '');
      const fields = TYPE_FIELDS[typeNameArg];
      const enums = TYPE_ENUM_VALUES[typeNameArg];
      if (fields === undefined && enums === undefined) return null;
      return {
        __t: '__Type',
        __d: {
          name: typeNameArg,
          kind: enums !== undefined ? 'ENUM' : 'OBJECT',
          fields: fields === undefined ? null : fields.map((f) => ({ name: f })),
          enumValues: enums === undefined ? null : enums.map((e) => ({ name: e })),
        },
      };
    }
    if (name === '__schema') {
      return {
        __t: '__Schema',
        __d: {
          queryType: { name: 'Query' },
          mutationType: { name: 'Mutation' },
          types: [...Object.keys(TYPE_FIELDS), ...Object.keys(TYPE_ENUM_VALUES)].map((n) => ({ name: n })),
        },
      };
    }
  }

  if (typeName === 'Mutation') {
    if (name === 'createIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repoNodeFound = findRepoByGlobalId(store, String(input.repositoryId ?? ''));
      if (repoNodeFound === null) return { __t: 'CreateIssuePayload', __d: { issue: null } };
      const repo = repoNodeFound.__d as NonNullable<ReturnType<Store['getRepo']>>;
      const r = store.createIssue(`${repo.owner.login}/${repo.name}`, String(input.title ?? ''), typeof input.body === 'string' ? input.body : undefined, []);
      if ('error' in r) return { __t: 'CreateIssuePayload', __d: { issue: null } };
      return { __t: 'CreateIssuePayload', __d: { issue: issueNode(`${repo.owner.login}/${repo.name}`, r.issue) } };
    }
    if (name === 'closeIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findIssueByGlobalId(store, String(input.issueId ?? ''));
      if (found === null) return { __t: 'CloseIssuePayload', __d: { issue: null } };
      const issue = (found.__d as { issue: NonNullable<ReturnType<Store['getIssue']>> }).issue;
      issue.state = 'closed';
      issue.closed_at = store.nowIso();
      issue.updated_at = store.nowIso();
      return { __t: 'CloseIssuePayload', __d: { issue: found } };
    }
    if (name === 'createPullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repoNodeFound = findRepoByGlobalId(store, String(input.repositoryId ?? ''));
      if (repoNodeFound === null) return { __t: 'CreatePullRequestPayload', __d: { pullRequest: null } };
      const repo = repoNodeFound.__d as NonNullable<ReturnType<Store['getRepo']>>;
      const repoKey = `${repo.owner.login}/${repo.name}`;
      const r = store.createPull(repoKey, String(input.title ?? ''), typeof input.body === 'string' ? input.body : undefined, String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
      if ('error' in r) return { __t: 'CreatePullRequestPayload', __d: { pullRequest: null } };
      return { __t: 'CreatePullRequestPayload', __d: { pullRequest: pullNode(repoKey, r.pull) } };
    }
    if (name === 'mergePullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findPullByGlobalId(store, String(input.pullRequestId ?? ''));
      if (found === null) return { __t: 'MergePullRequestPayload', __d: { pullRequest: null } };
      const pullData = found.__d as { repoKey: string; pull: NonNullable<ReturnType<Store['getPull']>> };
      store.mergePull(pullData.repoKey, pullData.pull.number);
      return { __t: 'MergePullRequestPayload', __d: { pullRequest: found } };
    }
    if (name === 'addComment') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findIssueByGlobalId(store, String(input.subjectId ?? ''));
      if (found === null) return { __t: 'AddCommentPayload', __d: { commentEdge: null } };
      const issue = (found.__d as { issue: NonNullable<ReturnType<Store['getIssue']>> }).issue;
      const comment = addIssueComment(issue, String(input.body ?? ''), store.nowIso());
      issue.comments = issue.comments + 1;
      return {
        __t: 'AddCommentPayload',
        __d: { commentEdge: { node: { __t: 'IssueComment', __d: { id: comment.nodeId, body: comment.body } } } },
      };
    }
  }

  if (typeName === 'Repository') {
    const repo = data as NonNullable<ReturnType<Store['getRepo']>>;
    const repoKey = `${repo.owner.login}/${repo.name}`;
    if (name === 'id') return repo.node_id;
    if (name === 'databaseId') return repo.id;
    if (name === 'name') return repo.name;
    if (name === 'nameWithOwner') return repo.full_name;
    if (name === 'owner') return { __t: 'User', __d: repo.owner };
    if (name === 'defaultBranchRef') {
      const tip = store.getRef(repoKey, `refs/heads/${repo.default_branch}`);
      return tip === undefined ? null : { __t: 'Ref', __d: { name: repo.default_branch } };
    }
    if (name === 'viewerPermission') return 'ADMIN';
    if (name === 'hasIssuesEnabled') return true;
    if (name === 'description') return repo.description;
    if (name === 'issue') {
      const issue = store.getIssue(repoKey, Number(args.number));
      return issue === undefined ? null : issueNode(repoKey, issue);
    }
    if (name === 'issues') return issuesConnection(store, repoKey, args);
    if (name === 'pullRequests') return pullRequestsConnection(store, repoKey, args);
    if (name === 'pullRequest') {
      const pull = store.getPull(repoKey, Number(args.number));
      return pull === undefined ? null : pullNode(repoKey, pull);
    }
  }

  if (typeName === 'Issue') {
    const issue = (data as { issue: NonNullable<ReturnType<Store['getIssue']>> }).issue;
    if (name === 'id') return issue.node_id;
    if (name === 'number') return issue.number;
    if (name === 'title') return issue.title;
    if (name === 'state') return issue.state.toUpperCase();
    if (name === 'body') return issue.body;
  }

  if (typeName === 'PullRequest') {
    const pull = (data as { repoKey: string; pull: NonNullable<ReturnType<Store['getPull']>> }).pull;
    const repoKey = (data as { repoKey: string }).repoKey;
    if (name === 'id') return pull.node_id;
    if (name === 'number') return pull.number;
    if (name === 'title') return pull.title;
    if (name === 'state') return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    if (name === 'merged') return pull.merged;
    if (name === 'headRefName') return pull.head.ref;
    if (name === 'baseRefName') return pull.base.ref;
    if (name === 'mergeable') return pull.mergeable ? 'MERGEABLE' : 'CONFLICTING';
    if (name === 'body') return pull.body;
    if (name === 'files') return pullFilesConnection(store, repoKey, pull, args);
  }

  if (typeName === 'User') {
    const user = data as { login: string; id: number; name: string; email: string };
    if (name === 'login') return user.login;
    if (name === 'id') return user.id;
    if (name === 'name') return user.name;
    if (name === 'email') return user.email;
  }

  // Plain-object fallback: pageInfo, connections' scalar fields, payloads,
  // __Type/__Schema bits, comment edges, Ref names.
  if (typeof data === 'object' && data !== null) {
    const record = data as Record<string, unknown>;
    if (name in record) return record[name];
  }

  return { __error: `Cannot query field "${name}" on type "${typeName}".` };
}

function resolveSelections(ctx: Ctx, selections: SelectionNode[], node: GNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.name !== undefined) {
        const frag = ctx.fragments.get(sel.name);
        if (frag !== undefined) {
          const merged = resolveSelections(ctx, frag.selections, node, variables);
          for (const k of Object.keys(merged)) out[k] = merged[k];
        }
        continue;
      }
      if (sel.typeCondition !== undefined && sel.typeCondition !== node.__t) continue;
      const merged = resolveSelections(ctx, sel.selections, node, variables);
      for (const k of Object.keys(merged)) out[k] = merged[k];
      continue;
    }
    const alias = sel.alias ?? sel.name;
    const value = resolveField(ctx, node.__t, sel, node.__d, variables);
    if (typeof value === 'object' && value !== null && '__error' in (value as Record<string, unknown>)) {
      ctx.errors.push({ message: String((value as Record<string, unknown>).__error) });
      out[alias] = null;
      continue;
    }
    if (sel.selections === undefined) {
      out[alias] = value === undefined ? null : value;
      continue;
    }
    if (value === null || value === undefined) {
      out[alias] = null;
      continue;
    }
    if (isGNode(value)) {
      out[alias] = resolveSelections(ctx, sel.selections, value, variables);
      continue;
    }
    if (Array.isArray(value)) {
      out[alias] = value.map((entry) => {
        if (isGNode(entry)) return resolveSelections(ctx, sel.selections as SelectionNode[], entry, variables);
        if (typeof entry === 'object' && entry !== null) {
          return resolveSelections(ctx, sel.selections as SelectionNode[], { __t: 'Plain', __d: entry }, variables);
        }
        return entry;
      });
      continue;
    }
    if (typeof value === 'object') {
      out[alias] = resolveSelections(ctx, sel.selections, { __t: 'Plain', __d: value }, variables);
      continue;
    }
    out[alias] = value;
  }
  return out;
}

function executeOperation(store: Store, query: string, variables: Record<string, unknown>, operationName: string | undefined): { data?: Json; errors?: Array<{ message: string }> } {
  let parsed: { operations: OperationNode[]; fragments: Map<string, FragmentNode> };
  try {
    parsed = new Parser(tokenize(query)).parseDocument();
  } catch (e) {
    return { data: {}, errors: [{ message: e instanceof Error ? e.message : 'GraphQL parse error' }] };
  }
  let op: OperationNode | undefined;
  if (operationName !== undefined) op = parsed.operations.find((o) => o.name === operationName);
  else if (parsed.operations.length === 1) op = parsed.operations[0];
  else if (parsed.operations.length > 1) op = parsed.operations[0];
  if (op === undefined) return { data: {}, errors: [{ message: 'No operation found' }] };
  const vars: Record<string, unknown> = { ...variables };
  for (const v of op.variables) {
    if (!(v.name in vars) && v.defaultValue !== undefined) vars[v.name] = resolveValue(v.defaultValue, variables);
  }
  const ctx: Ctx = { store, errors: [], fragments: parsed.fragments };
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = resolveSelections(ctx, op.selections, { __t: rootType, __d: {} }, vars);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
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

export async function handleGraphql(store: Store, req: IncomingMessage, res: ServerResponse, ctx: HandlerContext): Promise<void> {
  const rid = ctx.requestId ?? store.nextRequestId();
  const token = ctx.token !== undefined && ctx.token !== '' ? ctx.token : process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const send = (status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json', 'x-github-request-id': rid });
    res.end(JSON.stringify(body));
  };
  if ((req.method ?? 'GET') !== 'POST') {
    send(404, { message: 'Not Found' });
    return;
  }
  // server.ts already enforces auth before dispatching; this is the second
  // line of defence (and the only one when driven directly in tests).
  if (token !== '' && req.headers.authorization !== `Bearer ${token}`) {
    send(401, { message: 'Bad credentials' });
    return;
  }
  let text = '';
  try {
    text = await readBody(req);
  } catch {
    send(400, { errors: [{ message: 'Could not read request body' }] });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    send(400, { errors: [{ message: 'Malformed JSON in request body' }] });
    return;
  }
  // Batched operations: an array of {query, variables, operationName} answers
  // an array of results in order.
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => {
      if (typeof entry !== 'object' || entry === null) return { data: {}, errors: [{ message: 'Invalid operation' }] };
      const e = entry as Record<string, unknown>;
      return executeOperation(store, String(e.query ?? ''), (e.variables ?? {}) as Record<string, unknown>, typeof e.operationName === 'string' ? e.operationName : undefined);
    });
    send(200, results);
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    send(400, { errors: [{ message: 'Request body must be a JSON object' }] });
    return;
  }
  const body = parsed as Record<string, unknown>;
  const result = executeOperation(
    store,
    String(body.query ?? ''),
    (body.variables ?? {}) as Record<string, unknown>,
    typeof body.operationName === 'string' ? body.operationName : undefined,
  );
  send(200, result);
}
