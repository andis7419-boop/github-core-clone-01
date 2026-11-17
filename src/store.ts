// store.ts — the single source of truth: repositories, git refs/objects, contents,
// labels, issues and pull requests. All in-memory Maps; all timestamps are the trial
// now (util.ts); all ids are sequential counters from 1. No wall-clock reads,
// no unseeded randomness, no fs, no git binary.
//
// Public API is DESIGN.md section 2, exactly. The extra methods at the end (marked
// "helpers for the route layers") are conveniences for rest.ts / git-http.ts /
// graphql.ts / mcp.ts; they add nothing the frozen API forbids.
//
// Two deliberate deviations from DESIGN.md §2, both forced by the conformance checks
// (see NOTES.md):
//  - Repo.private is `boolean`, not the literal `false`: checks create repos with
//    private:true and read it back. createRepo takes an optional third `isPrivate`.
//  - Issue.comments is `number` (the live comment count), not the literal `0`:
//    rest.ts keeps it in sync when comments are added. Comments themselves live in
//    rest.ts's WeakMap (the frozen Store API has no comment methods).

import { buildCommit, buildTree, hashObject, parseCommit, parseTree } from './git-objects.ts';
import type { GitObjectType } from './git-objects.ts';
import { b64encode, Counter, trialNowIso, trialNowSec } from './util.ts';

export type { GitObjectType };

export interface User { id: number; login: string; name: string; email: string; type: 'User' }

export interface Repo {
  id: number; node_id: string; name: string; full_name: string; owner: User;
  private: boolean; description: string; default_branch: string;
  created_at: string; updated_at: string; pushed_at: string;
  html_url: string; clone_url: string; git_url: string; ssh_url: string;
  homepage: string | null; language: string | null;
  forks_count: 0; stargazers_count: 0; watchers_count: 0; open_issues_count: number;
  open_issues: number; has_issues: true; has_projects: true; has_wiki: true;
  archived: false; disabled: false; visibility: 'public';
}

export interface Label { id: number; node_id: string; name: string; color: string; description: string; url: string }

export interface Issue {
  id: number; node_id: string; number: number; title: string; body: string | null;
  state: 'open' | 'closed'; locked: boolean; labels: Label[];
  user: User; assignee: null; assignees: []; comments: number;
  created_at: string; updated_at: string; closed_at: string | null;
  html_url: string; url: string; repository_url: string;
}

export interface Pull {
  id: number; node_id: string; number: number; title: string; body: string | null;
  state: 'open' | 'closed'; locked: boolean; merged: boolean; mergeable: boolean;
  merge_commit_sha: string | null; merged_at: string | null;
  head: { ref: string; sha: string; label: string; repo: Repo | null };
  base: { ref: string; sha: string; label: string; repo: Repo | null };
  user: User; created_at: string; updated_at: string; closed_at: string | null;
  html_url: string; url: string;
}

/** One file in a flattened tree: its git mode and blob id. */
export interface FileEntry {
  mode: string;
  oid: string;
}

/** One changed file between two trees, for GET /pulls/{n}/files. */
export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

interface RepoState {
  repo: Repo;
  refs: Map<string, string>;
  objects: Map<string, { type: GitObjectType; data: Buffer }>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextIssue: number;
  nextPull: number;
}

const ZERO_OID = '0000000000000000000000000000000000000000';

export class Store {
  /** The token's owner: adaiversen (id 1000). Every repo belongs to this login. */
  readonly viewer: User = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid', type: 'User' };

  private reqCounter = new Counter(1);
  private repoIdCounter = new Counter(1);
  private issueIdCounter = new Counter(1);
  private pullIdCounter = new Counter(1);
  private labelIdCounter = new Counter(1);
  private repos = new Map<string, RepoState>();
  /** Base URL embedded in html_url / url fields; default is deterministic and port-free. */
  private baseUrl = 'https://example.invalid';

  constructor() {
    // The trial clock lives in util.ts; nothing here reads the wall clock.
  }

  /** Trial now, ISO 8601. */
  nowIso(): string {
    return trialNowIso();
  }

  /** Trial now, epoch seconds. */
  nowSec(): number {
    return trialNowSec();
  }

  /** `req-<n>`, monotonic from 1. */
  nextRequestId(): string {
    return `req-${this.reqCounter.next()}`;
  }

  /**
   * The origin embedded in html_url / url fields of objects created after the call
   * (e.g. `http://127.0.0.1:<port>` once the server has bound). Call once at startup;
   * objects created before the call keep the default base. Trailing slashes are stripped.
   */
  setBaseUrl(origin: string): void {
    this.baseUrl = origin.replace(/\/+$/, '');
  }

  private key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  private authorLine(): string {
    return `${this.viewer.name} <${this.viewer.email}>`;
  }

  private state(repoKey: string): RepoState | undefined {
    return this.repos.get(repoKey);
  }

  // ---------------------------------------------------------------------------
  // Repositories

  createRepo(name: string, description?: string, isPrivate?: boolean): Repo | null {
    const key = this.key(this.viewer.login, name);
    if (name === '' || this.repos.has(key)) return null;
    const id = this.repoIdCounter.next();
    const repo: Repo = {
      id, node_id: b64encode(`Repository:${id}`), name, full_name: key,
      owner: this.viewer, private: isPrivate ?? false, description: description ?? '',
      default_branch: 'main', created_at: this.nowIso(), updated_at: this.nowIso(), pushed_at: this.nowIso(),
      html_url: `${this.baseUrl}/${key}`, clone_url: `${this.baseUrl}/${key}.git`,
      git_url: `git://${this.baseUrl.replace(/^https?:\/\//, '')}/${key}.git`,
      ssh_url: `git@example.invalid:${key}.git`,
      homepage: null, language: null, forks_count: 0, stargazers_count: 0, watchers_count: 0,
      open_issues_count: 0, open_issues: 0, has_issues: true, has_projects: true, has_wiki: true,
      archived: false, disabled: false, visibility: 'public',
    };
    this.repos.set(key, {
      repo, refs: new Map(), objects: new Map(), labels: new Map(),
      issues: new Map(), pulls: new Map(), nextIssue: 1, nextPull: 1,
    });
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== this.viewer.login) return undefined;
    return this.repos.get(this.key(owner, name))?.repo;
  }

  /** All of the viewer's repos, in creation order. */
  listViewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const st of this.repos.values()) out.push(st.repo);
    return out;
  }

  updateRepo(owner: string, name: string, patch: { description?: string }): Repo | undefined {
    const st = owner === this.viewer.login ? this.repos.get(this.key(owner, name)) : undefined;
    if (st === undefined) return undefined;
    if (patch.description !== undefined) st.repo.description = patch.description;
    st.repo.updated_at = this.nowIso();
    return st.repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== this.viewer.login) return false;
    return this.repos.delete(this.key(owner, name));
  }

  // ---------------------------------------------------------------------------
  // Git refs & objects (repoKey = `${owner}/${name}`)

  getRef(repoKey: string, ref: string): string | undefined {
    return this.state(repoKey)?.refs.get(ref);
  }

  setRef(repoKey: string, ref: string, oid: string): void {
    this.state(repoKey)?.refs.set(ref, oid);
  }

  deleteRef(repoKey: string, ref: string): boolean {
    const st = this.state(repoKey);
    if (st === undefined) return false;
    return st.refs.delete(ref);
  }

  /** Every ref, sorted by name. */
  listRefs(repoKey: string): Array<{ name: string; oid: string }> {
    const st = this.state(repoKey);
    if (st === undefined) return [];
    const out = [...st.refs.entries()].map(([name, oid]) => ({ name, oid }));
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  putObject(repoKey: string, type: GitObjectType, data: Buffer): string {
    const st = this.state(repoKey);
    if (st === undefined) throw new Error(`putObject on missing repo ${repoKey}`);
    const oid = hashObject(type, data);
    st.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repoKey: string, oid: string): { type: GitObjectType; data: Buffer } | undefined {
    return this.state(repoKey)?.objects.get(oid);
  }

  hasObject(repoKey: string, oid: string): boolean {
    return this.state(repoKey)?.objects.has(oid) ?? false;
  }

  /**
   * Whether `maybeAncestor` is reachable from `oid` by following parent links
   * (an object is its own ancestor, so a ref update to the same oid fast-forwards).
   * Missing objects end the walk: false.
   */
  isAncestor(repoKey: string, maybeAncestor: string, oid: string): boolean {
    if (maybeAncestor === oid) return true;
    if (maybeAncestor === ZERO_OID) return true;
    const seen = new Set<string>();
    const stack = [oid];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const obj = this.getObject(repoKey, cur);
      if (obj === undefined || obj.type !== 'commit') continue;
      const commit = parseCommit(obj.data);
      for (const parent of commit.parents) {
        if (parent === maybeAncestor) return true;
        stack.push(parent);
      }
    }
    return false;
  }

  /** `refs/heads/<default branch>` for the repo (`refs/heads/main` when unknown). */
  headRef(repoKey: string): string {
    return `refs/heads/${this.getDefaultBranch(repoKey)}`;
  }

  // ---------------------------------------------------------------------------
  // Contents (files as git commits on a branch; default = the default branch)

  /** Flatten a tree object into path -> {mode, oid}, recursing into subtrees. */
  private flattenTree(repoKey: string, treeOid: string, prefix: string, out: Map<string, FileEntry>): void {
    const obj = this.getObject(repoKey, treeOid);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') this.flattenTree(repoKey, entry.oid, path, out);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  }

  /** Files at the tip of `ref`, or an empty map when the ref is unborn. */
  private filesAtRef(repoKey: string, ref: string): { files: Map<string, FileEntry>; parents: string[] } {
    const files = new Map<string, FileEntry>();
    const tip = this.getRef(repoKey, ref);
    if (tip === undefined) return { files, parents: [] };
    const obj = this.getObject(repoKey, tip);
    if (obj === undefined || obj.type !== 'commit') return { files, parents: [] };
    this.flattenTree(repoKey, parseCommit(obj.data).tree, '', files);
    return { files, parents: [tip] };
  }

  /** Rebuild the tree objects for `files` (a path -> entry map) bottom-up; returns the root tree oid. */
  private rebuildTree(repoKey: string, files: Map<string, FileEntry>): string {
    interface DirNode {
      files: Map<string, FileEntry>;
      dirs: Map<string, DirNode>;
    }
    const root: DirNode = { files: new Map(), dirs: new Map() };
    for (const [path, entry] of files) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const part = parts[i] as string;
        let child = node.dirs.get(part);
        if (child === undefined) {
          child = { files: new Map(), dirs: new Map() };
          node.dirs.set(part, child);
        }
        node = child;
      }
      node.files.set(parts[parts.length - 1] as string, entry);
    }
    const build = (node: DirNode): string => {
      const entries: Array<{ mode: string; name: string; oid: string }> = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repoKey, 'tree', buildTree(entries));
    };
    return build(root);
  }

  private commitTree(
    repoKey: string,
    ref: string,
    files: Map<string, FileEntry>,
    parents: string[],
    message: string,
  ): string {
    const tree = this.rebuildTree(repoKey, files);
    const sha = this.putObject(
      repoKey,
      'commit',
      buildCommit({ tree, parents, message, timestamp: this.nowSec(), author: this.authorLine(), committer: this.authorLine() }),
    );
    this.setRef(repoKey, ref, sha);
    const st = this.state(repoKey);
    if (st !== undefined) {
      st.repo.pushed_at = this.nowIso();
      st.repo.updated_at = this.nowIso();
    }
    return sha;
  }

  createOrUpdateFile(
    repoKey: string,
    path: string,
    contentBase64: string,
    message: string,
    sha?: string,
    branch?: string,
  ): { commitSha: string; blobSha: string; created: boolean } | { error: 'stale' | 'not_found' } {
    const st = this.state(repoKey);
    if (st === undefined) return { error: 'not_found' };
    const ref = branch !== undefined && branch !== '' ? `refs/heads/${branch}` : this.headRef(repoKey);
    const { files, parents } = this.filesAtRef(repoKey, ref);
    const existed = files.has(path);
    if (sha !== undefined && (!existed || files.get(path)?.oid !== sha)) return { error: 'stale' };
    const blobSha = this.putObject(repoKey, 'blob', Buffer.from(contentBase64, 'base64'));
    const mode = files.get(path)?.mode ?? '100644';
    files.set(path, { mode, oid: blobSha });
    const commitSha = this.commitTree(repoKey, ref, files, parents, message === '' ? `Update ${path}` : message);
    return { commitSha, blobSha, created: !existed };
  }

  deleteFile(
    repoKey: string,
    path: string,
    message: string,
    sha?: string,
    branch?: string,
  ): { commitSha: string } | { error: 'not_found' } {
    const st = this.state(repoKey);
    if (st === undefined) return { error: 'not_found' };
    const ref = branch !== undefined && branch !== '' ? `refs/heads/${branch}` : this.headRef(repoKey);
    const { files, parents } = this.filesAtRef(repoKey, ref);
    const current = files.get(path);
    // A sha that does not name the current blob is reported the same way as a
    // missing file: this method's error union has no 'stale' member.
    if (current === undefined || (sha !== undefined && sha !== current.oid)) return { error: 'not_found' };
    files.delete(path);
    const commitSha = this.commitTree(repoKey, ref, files, parents, message === '' ? `Delete ${path}` : message);
    return { commitSha };
  }

  /** The blob at the default branch tip for `path`, or undefined when absent. */
  readFile(repoKey: string, path: string): { sha: string; contentBase64: string } | undefined {
    const st = this.state(repoKey);
    if (st === undefined) return undefined;
    const { files } = this.filesAtRef(repoKey, this.headRef(repoKey));
    const entry = files.get(path);
    if (entry === undefined) return undefined;
    const blob = this.getObject(repoKey, entry.oid);
    if (blob === undefined) return undefined;
    return { sha: entry.oid, contentBase64: blob.data.toString('base64') };
  }

  // ---------------------------------------------------------------------------
  // Labels / issues / pulls

  createLabel(repoKey: string, name: string, color?: string, description?: string): Label {
    const st = this.state(repoKey);
    if (st === undefined) throw new Error(`createLabel on missing repo ${repoKey}`);
    const existing = st.labels.get(name);
    if (existing !== undefined) return existing;
    const id = this.labelIdCounter.next();
    const label: Label = {
      id, node_id: b64encode(`Label:${id}`), name, color: color ?? 'ededed', description: description ?? '',
      url: `${this.baseUrl}/api/v3/repos/${repoKey}/labels/${encodeURIComponent(name)}`,
    };
    st.labels.set(name, label);
    return label;
  }

  getLabel(repoKey: string, name: string): Label | undefined {
    return this.state(repoKey)?.labels.get(name);
  }

  listLabels(repoKey: string): Label[] {
    return [...(this.state(repoKey)?.labels.values() ?? [])];
  }

  createIssue(
    repoKey: string,
    title: string,
    body: string | undefined,
    labels: string[],
  ): { issue: Issue } | { error: 'label'; label: string } {
    const st = this.state(repoKey);
    if (st === undefined) return { error: 'label', label: labels[0] ?? '' };
    const attached: Label[] = [];
    for (const name of labels) {
      const found = st.labels.get(name);
      if (found === undefined) return { error: 'label', label: name };
      attached.push(found);
    }
    const id = this.issueIdCounter.next();
    const number = st.nextIssue;
    st.nextIssue += 1;
    const issue: Issue = {
      id, node_id: b64encode(`Issue:${id}`), number, title, body: body ?? null,
      state: 'open', locked: false, labels: attached, user: this.viewer, assignee: null, assignees: [],
      comments: 0, created_at: this.nowIso(), updated_at: this.nowIso(), closed_at: null,
      html_url: `${this.baseUrl}/${repoKey}/issues/${number}`,
      url: `${this.baseUrl}/api/v3/repos/${repoKey}/issues/${number}`,
      repository_url: `${this.baseUrl}/api/v3/repos/${repoKey}`,
    };
    st.issues.set(number, issue);
    st.repo.open_issues_count += 1;
    st.repo.open_issues += 1;
    return { issue };
  }

  getIssue(repoKey: string, number: number): Issue | undefined {
    return this.state(repoKey)?.issues.get(number);
  }

  /** Issues in number order (ASC); callers sort when they need another order. */
  listIssues(repoKey: string, state?: 'open' | 'closed' | 'all'): Issue[] {
    const st = this.state(repoKey);
    if (st === undefined) return [];
    const out = [...st.issues.values()];
    out.sort((a, b) => a.number - b.number);
    if (state === 'open') return out.filter((issue) => issue.state === 'open');
    if (state === 'closed') return out.filter((issue) => issue.state === 'closed');
    return out;
  }

  createPull(
    repoKey: string,
    title: string,
    body: string | undefined,
    head: string,
    base: string,
  ): { pull: Pull } | { error: 'head' | 'base' } {
    const st = this.state(repoKey);
    if (st === undefined) return { error: 'head' };
    const headRef = head.startsWith('refs/') ? head : `refs/heads/${head}`;
    const baseRef = base.startsWith('refs/') ? base : `refs/heads/${base}`;
    const headSha = st.refs.get(headRef);
    if (headSha === undefined) return { error: 'head' };
    const baseSha = st.refs.get(baseRef);
    if (baseSha === undefined) return { error: 'base' };
    const id = this.pullIdCounter.next();
    const number = st.nextPull;
    st.nextPull += 1;
    const headName = headRef.slice('refs/heads/'.length);
    const baseName = baseRef.slice('refs/heads/'.length);
    const mergeable = this.isAncestor(repoKey, baseSha, headSha) || this.isAncestor(repoKey, headSha, baseSha);
    const pull: Pull = {
      id, node_id: b64encode(`PullRequest:${id}`), number, title, body: body ?? null,
      state: 'open', locked: false, merged: false, mergeable, merge_commit_sha: null, merged_at: null,
      head: { ref: headName, sha: headSha, label: `${this.viewer.login}:${headName}`, repo: st.repo },
      base: { ref: baseName, sha: baseSha, label: `${this.viewer.login}:${baseName}`, repo: st.repo },
      user: this.viewer, created_at: this.nowIso(), updated_at: this.nowIso(), closed_at: null,
      html_url: `${this.baseUrl}/${repoKey}/pull/${number}`,
      url: `${this.baseUrl}/api/v3/repos/${repoKey}/pulls/${number}`,
    };
    st.pulls.set(number, pull);
    return { pull };
  }

  getPull(repoKey: string, number: number): Pull | undefined {
    return this.state(repoKey)?.pulls.get(number);
  }

  listPulls(repoKey: string, state?: 'open' | 'closed' | 'all'): Pull[] {
    const st = this.state(repoKey);
    if (st === undefined) return [];
    const out = [...st.pulls.values()];
    out.sort((a, b) => a.number - b.number);
    if (state === 'open') return out.filter((pull) => pull.state === 'open');
    if (state === 'closed') return out.filter((pull) => pull.state === 'closed');
    return out;
  }

  /**
   * Squash-merge: one new commit on the base branch whose tree is the head's tree,
   * parents [base tip], message = the pull title. Closes the pull (merged = true).
   *
   * Conflict rule (DESIGN §2, matching checks-rest.ts pulls-merge-conflict): the
   * merge conflicts exactly when the head tip is not a descendant of the base tip
   * AND the base tip is not a descendant of the head tip — i.e. the branches have
   * diverged. Either direction of ancestry merges cleanly.
   */
  mergePull(
    repoKey: string,
    number: number,
  ): { sha: string; merged: true; message: string } | { error: 'not_found' | 'conflict' | 'already_merged' } {
    const st = this.state(repoKey);
    const pull = st?.pulls.get(number);
    if (st === undefined || pull === undefined) return { error: 'not_found' };
    if (pull.merged || pull.state === 'closed') return { error: 'already_merged' };
    const headTip = st.refs.get(`refs/heads/${pull.head.ref}`);
    const baseTip = st.refs.get(`refs/heads/${pull.base.ref}`);
    if (headTip === undefined || baseTip === undefined) return { error: 'not_found' };
    if (!this.isAncestor(repoKey, baseTip, headTip) && !this.isAncestor(repoKey, headTip, baseTip)) {
      return { error: 'conflict' };
    }
    const headObj = this.getObject(repoKey, headTip);
    if (headObj === undefined || headObj.type !== 'commit') return { error: 'not_found' };
    const headCommit = parseCommit(headObj.data);
    const sha = this.putObject(
      repoKey,
      'commit',
      buildCommit({ tree: headCommit.tree, parents: [baseTip], message: pull.title, timestamp: this.nowSec(), author: this.authorLine(), committer: this.authorLine() }),
    );
    st.refs.set(`refs/heads/${pull.base.ref}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.merge_commit_sha = sha;
    pull.merged_at = this.nowIso();
    pull.closed_at = this.nowIso();
    pull.updated_at = this.nowIso();
    pull.base.sha = sha;
    st.repo.pushed_at = this.nowIso();
    st.repo.updated_at = this.nowIso();
    return { sha, merged: true, message: pull.title };
  }

  // ---------------------------------------------------------------------------
  // Helpers for the route layers (not part of the frozen DESIGN §2 API).

  /** The repo's default branch name (`main` when the repo is unknown). */
  getDefaultBranch(repoKey: string): string {
    return this.state(repoKey)?.repo.default_branch ?? 'main';
  }

  /** Refresh a repo's pushed_at / updated_at to the trial now (after a push or merge). */
  touchRepo(repoKey: string): void {
    const st = this.state(repoKey);
    if (st === undefined) return;
    st.repo.pushed_at = this.nowIso();
    st.repo.updated_at = this.nowIso();
  }

  /** The parsed commit at `oid`, or undefined when missing / not a commit. */
  readCommit(repoKey: string, oid: string): ReturnType<typeof parseCommit> | undefined {
    const obj = this.getObject(repoKey, oid);
    if (obj === undefined || obj.type !== 'commit') return undefined;
    return parseCommit(obj.data);
  }

  /**
   * Commits reachable from `ref` (a branch name, a full ref, or an oid), newest
   * first by first-parent visit order, deduplicated. `limit` caps the walk.
   */
  listCommits(
    repoKey: string,
    ref: string,
    limit?: number,
  ): Array<{ sha: string; tree: string; parents: string[]; message: string; author: string; committer: string; timestamp: number }> {
    let tip = ref.startsWith('refs/') ? this.getRef(repoKey, ref) : this.getRef(repoKey, `refs/heads/${ref}`);
    if (tip === undefined && this.hasObject(repoKey, ref)) tip = ref;
    if (tip === undefined) return [];
    const out: Array<{ sha: string; tree: string; parents: string[]; message: string; author: string; committer: string; timestamp: number }> = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      if (limit !== undefined && out.length >= limit) break;
      const sha = stack.pop() as string;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const commit = this.readCommit(repoKey, sha);
      if (commit === undefined) continue;
      out.push({ sha, ...commit });
      for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i] as string);
    }
    return out;
  }

  /** Every file under `treeOid`, as flat `{path, mode, oid}` entries sorted by path. */
  listTreeFiles(repoKey: string, treeOid: string): Array<{ path: string; mode: string; oid: string }> {
    const files = new Map<string, FileEntry>();
    this.flattenTree(repoKey, treeOid, '', files);
    const out = [...files.entries()].map(([path, entry]) => ({ path, mode: entry.mode, oid: entry.oid }));
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return out;
  }

  /** The `{mode, oid}` of one path inside a tree, or undefined when absent. */
  getTreeEntry(repoKey: string, treeOid: string, path: string): FileEntry | undefined {
    const parts = path.split('/').filter((part) => part !== '');
    let current = treeOid;
    for (let i = 0; i < parts.length; i += 1) {
      const obj = this.getObject(repoKey, current);
      if (obj === undefined || obj.type !== 'tree') return undefined;
      const entry = parseTree(obj.data).find((candidate) => candidate.name === parts[i]);
      if (entry === undefined) return undefined;
      if (i === parts.length - 1) return { mode: entry.mode, oid: entry.oid };
      if (entry.mode !== '40000') return undefined;
      current = entry.oid;
    }
    return undefined;
  }

  /** Number of lines in a blob's UTF-8 text (a trailing newline ends the last line, it is not another). */
  private lineCount(data: Buffer): number {
    if (data.length === 0) return 0;
    const text = data.toString('utf8');
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines.length;
  }

  /** Multiset line diff: lines added in `next` vs `prev`, and lines removed. */
  private lineDiff(prev: Buffer, next: Buffer): { additions: number; deletions: number } {
    const countLines = (data: Buffer): Map<string, number> => {
      const counts = new Map<string, number>();
      if (data.length === 0) return counts;
      const lines = data.toString('utf8').split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
      return counts;
    };
    const prevCounts = countLines(prev);
    const nextCounts = countLines(next);
    let additions = 0;
    let deletions = 0;
    for (const [line, n] of nextCounts) additions += Math.max(0, n - (prevCounts.get(line) ?? 0));
    for (const [line, n] of prevCounts) deletions += Math.max(0, n - (nextCounts.get(line) ?? 0));
    return { additions, deletions };
  }

  /**
   * The file-level diff between two trees, for GET /pulls/{n}/files: added, removed
   * and modified paths with line counts, sorted by filename. Unchanged paths are omitted.
   */
  diffTreeFiles(repoKey: string, baseTreeOid: string, headTreeOid: string): FileChange[] {
    const base = new Map(this.listTreeFiles(repoKey, baseTreeOid).map((entry) => [entry.path, entry.oid]));
    const head = new Map(this.listTreeFiles(repoKey, headTreeOid).map((entry) => [entry.path, entry.oid]));
    const out: FileChange[] = [];
    const blob = (oid: string): Buffer => this.getObject(repoKey, oid)?.data ?? Buffer.alloc(0);
    for (const [path, oid] of head) {
      const baseOid = base.get(path);
      if (baseOid === undefined) {
        const additions = this.lineCount(blob(oid));
        out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (baseOid !== oid) {
        const { additions, deletions } = this.lineDiff(blob(baseOid), blob(oid));
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    for (const [path, oid] of base) {
      if (!head.has(path)) {
        const deletions = this.lineCount(blob(oid));
        out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      }
    }
    out.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
    return out;
  }

  /**
   * Close/reopen an issue, keeping closed_at, updated_at and the repo's open-issue
   * counts in sync. (rest.ts's PATCH handler currently mutates the Issue object
   * directly instead of calling this; W4 may route it through here.)
   */
  setIssueState(repoKey: string, number: number, state: 'open' | 'closed'): Issue | undefined {
    const st = this.state(repoKey);
    const issue = st?.issues.get(number);
    if (st === undefined || issue === undefined) return undefined;
    if (issue.state !== state) {
      issue.state = state;
      issue.closed_at = state === 'closed' ? this.nowIso() : null;
      if (state === 'closed') {
        st.repo.open_issues_count = Math.max(0, st.repo.open_issues_count - 1);
        st.repo.open_issues = Math.max(0, st.repo.open_issues - 1);
      } else {
        st.repo.open_issues_count += 1;
        st.repo.open_issues += 1;
      }
    }
    issue.updated_at = this.nowIso();
    return issue;
  }
}
