// rest.ts — GitHub REST v3 surface. Every reply is JSON; unknown routes are 404 JSON;
// malformed JSON bodies are 400 JSON; every reply carries a non-empty X-GitHub-Request-Id
// (set by app.ts). Only the viewer login owns repositories: any other owner is a 404.

import {
  emptyTreeOid,
  parseCommit,
  parseTree,
  storeObject,
  treeGet,
  treeList,
  treeSet,
  treeWalkFiles,
  type Issue,
  type Label,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';
import { VIEWER } from './scenario.ts';

export interface RestResult {
  status: number;
  json: unknown;
  link?: string;
}

export interface Query {
  [key: string]: string | undefined;
}

const FIXED_DATE = '2026-01-01T00:00:00Z';

function ok(status: number, json: unknown, link?: string): RestResult {
  return { status, json, link };
}

function notFound(message = 'Not Found'): RestResult {
  return { status: 404, json: { message } };
}

function unprocessable(message: string): RestResult {
  return { status: 422, json: { message } };
}

function conflict(message: string): RestResult {
  return { status: 409, json: { message } };
}

function methodNotAllowed(message: string): RestResult {
  return { status: 405, json: { message } };
}

// ---------------------------------------------------------------- views

function userView(login: string): Record<string, unknown> {
  return {
    login,
    id: login === VIEWER.login ? VIEWER.id : 0,
    node_id: Buffer.from(`User:${login}`).toString('base64'),
    avatar_url: '',
    gravatar_id: '',
    url: `/api/v3/users/${login}`,
    html_url: `/${login}`,
    type: 'User',
    site_admin: false,
    name: login === VIEWER.login ? VIEWER.name : login,
    email: login === VIEWER.login ? VIEWER.email : null,
  };
}

export function repoView(repo: Repo, origin: string): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${fullName}`).toString('base64'),
    name: repo.name,
    full_name: fullName,
    owner: userView(repo.owner),
    private: repo.privateFlag,
    html_url: `${origin}/${fullName}`,
    description: repo.description,
    fork: false,
    url: `${origin}/api/v3/repos/${fullName}`,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    pushed_at: FIXED_DATE,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.privateFlag ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

function labelView(label: Label): Record<string, unknown> {
  return {
    id: 0,
    node_id: Buffer.from(`Label:${label.name}`).toString('base64'),
    url: '',
    name: label.name,
    color: label.color,
    default: false,
    description: '',
  };
}

export function issueView(issue: Issue, repo: Repo): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: Buffer.from(`Issue:${repo.owner}/${repo.name}:${issue.number}`).toString('base64'),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: userView(issue.userLogin),
    labels: issue.labels.map(labelView),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    closed_at: issue.state === 'closed' ? FIXED_DATE : null,
    author_association: 'OWNER',
    state_reason: null,
  };
}

function branchTipSha(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

export function pullView(pr: PullRequest, repo: Repo): Record<string, unknown> {
  const headSha = branchTipSha(repo, pr.headRef) ?? '';
  const baseSha = branchTipSha(repo, pr.baseRef) ?? '';
  return {
    id: pr.id,
    node_id: Buffer.from(`PullRequest:${repo.owner}/${repo.name}:${pr.number}`).toString('base64'),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
    html_url: `/${repo.owner}/${repo.name}/pulls/${pr.number}`,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    locked: false,
    user: userView(pr.userLogin),
    labels: [],
    milestone: null,
    active_lock_reason: null,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    closed_at: pr.state === 'closed' ? FIXED_DATE : null,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    merged: pr.merged,
    mergeable: computeMergeable(repo, pr),
    mergeable_state: 'clean',
    merged_by: null,
    head: {
      label: `${repo.owner}:${pr.headRef}`,
      ref: pr.headRef,
      sha: headSha,
      user: userView(repo.owner),
      repo: repoView(repo, ''),
    },
    base: {
      label: `${repo.owner}:${pr.baseRef}`,
      ref: pr.baseRef,
      sha: baseSha,
      user: userView(repo.owner),
      repo: repoView(repo, ''),
    },
    author_association: 'OWNER',
    draft: false,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

function commentView(comment: { id: number; body: string; userLogin: string }, repo: Repo, issueNumber: number): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: Buffer.from(`Comment:${repo.owner}/${repo.name}:${issueNumber}:${comment.id}`).toString('base64'),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userView(comment.userLogin),
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    author_association: 'OWNER',
  };
}

// ---------------------------------------------------------------- pagination

function pageParams(query: Query): { page: number; perPage: number } {
  const perPageRaw = parseInt(query.per_page ?? '30', 10);
  const pageRaw = parseInt(query.page ?? '1', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  return { page, perPage };
}

function paginate<T>(items: readonly T[], query: Query, origin: string, path: string): { page: T[]; link?: string } {
  const { page, perPage } = pageParams(query);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  if (totalPages <= 1) return { page: slice };
  const url = (p: number): string => `${origin}${path}?per_page=${perPage}&page=${p}`;
  const parts: string[] = [];
  if (page < totalPages) parts.push(`<${url(page + 1)}>; rel="next"`);
  parts.push(`<${url(totalPages)}>; rel="last"`);
  if (page > 1) parts.push(`<${url(1)}>; rel="first"`, `<${url(page - 1)}>; rel="prev"`);
  return { page: slice, link: parts.join(', ') };
}

// ---------------------------------------------------------------- repo helpers

function requireRepo(store: Store, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return store.getRepo(owner, name) ?? null;
}

function commitView(repo: Repo, sha: string): Record<string, unknown> | null {
  const obj = repo.objects.get(sha);
  if (!obj || obj.type !== 'commit') return null;
  const info = parseCommit(obj.data);
  const parseIdent = (ident: string): { name: string; email: string; date: string } => {
    const m = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(ident);
    if (!m) return { name: ident, email: '', date: FIXED_DATE };
    const ts = parseInt(m[3] as string, 10) * 1000;
    return { name: m[1] as string, email: m[2] as string, date: new Date(ts).toISOString() };
  };
  const author = parseIdent(info.author);
  const committer = parseIdent(info.committer);
  return {
    sha,
    node_id: Buffer.from(`Commit:${sha}`).toString('base64'),
    commit: {
      message: info.message,
      author,
      committer,
      tree: { sha: info.tree },
      url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}`,
      comment_count: 0,
    },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `/${repo.owner}/${repo.name}/commit/${sha}`,
    author: userView(VIEWER.login),
    committer: userView(VIEWER.login),
    parents: info.parents.map((p) => ({ sha: p, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${p}` })),
  };
}

// ---------------------------------------------------------------- diff / merge

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export function diffFiles(repo: Repo, baseTreeOid: string, headTreeOid: string): FileChange[] {
  const base = treeWalkFiles(repo.objects, baseTreeOid);
  const head = treeWalkFiles(repo.objects, headTreeOid);
  const paths = new Set([...base.keys(), ...head.keys()]);
  const out: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b === h) continue;
    if (b === undefined) {
      const lines = contentLines(repo, h as string);
      out.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
    } else if (h === undefined) {
      const lines = contentLines(repo, b);
      out.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
    } else {
      const { additions, deletions } = lineDiff(repo, b, h);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

function contentLines(repo: Repo, blobOid: string): number {
  const obj = repo.objects.get(blobOid);
  if (!obj) return 0;
  const text = obj.data.toString('utf8');
  if (text.length === 0) return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

function lineDiff(repo: Repo, oldOid: string, newOid: string): { additions: number; deletions: number } {
  const oldObj = repo.objects.get(oldOid);
  const newObj = repo.objects.get(newOid);
  const oldLines = oldObj ? oldObj.data.toString('utf8').split('\n') : [];
  const newLines = newObj ? newObj.data.toString('utf8').split('\n') : [];
  const count = (lines: string[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const oldCount = count(oldLines);
  const newCount = count(newLines);
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of newCount) {
    const d = n - (oldCount.get(line) ?? 0);
    if (d > 0) additions += d;
  }
  for (const [line, n] of oldCount) {
    const d = n - (newCount.get(line) ?? 0);
    if (d > 0) deletions += d;
  }
  return { additions, deletions };
}

/** Paths changed on both sides of the merge-base with different results. */
export function conflictingPaths(repo: Repo, pr: PullRequest): string[] {
  const baseTip = branchTipSha(repo, pr.baseRef);
  const headTip = branchTipSha(repo, pr.headRef);
  if (!baseTip || !headTip) return [];
  const baseObj = repo.objects.get(pr.baseSha);
  const headObj = repo.objects.get(headTip);
  const tipObj = repo.objects.get(baseTip);
  if (!baseObj || !headObj || !tipObj) return [];
  const mergeBaseTree = parseCommit(baseObj.data).tree;
  const headTree = parseCommit(headObj.data).tree;
  const tipTree = parseCommit(tipObj.data).tree;
  const mergeBase = treeWalkFiles(repo.objects, mergeBaseTree);
  const head = treeWalkFiles(repo.objects, headTree);
  const tip = treeWalkFiles(repo.objects, tipTree);
  const conflicts: string[] = [];
  const paths = new Set([...mergeBase.keys(), ...head.keys(), ...tip.keys()]);
  for (const path of paths) {
    const m = mergeBase.get(path);
    const h = head.get(path);
    const t = tip.get(path);
    const headChanged = h !== m;
    const tipChanged = t !== m;
    if (headChanged && tipChanged && h !== t) conflicts.push(path);
  }
  return conflicts.sort();
}

export function computeMergeable(repo: Repo, pr: PullRequest): boolean {
  if (pr.state !== 'open') return false;
  return conflictingPaths(repo, pr).length === 0;
}

export function squashMerge(store: Store, repo: Repo, pr: PullRequest): { ok: boolean; sha?: string; conflict?: boolean } {
  const baseTip = branchTipSha(repo, pr.baseRef);
  const headTip = branchTipSha(repo, pr.headRef);
  if (!baseTip || !headTip) return { ok: false };
  const conflicts = conflictingPaths(repo, pr);
  if (conflicts.length > 0) return { ok: false, conflict: true };
  const baseObj = repo.objects.get(pr.baseSha);
  const headObj = repo.objects.get(headTip);
  const tipObj = repo.objects.get(baseTip);
  if (!baseObj || !headObj || !tipObj) return { ok: false };
  const mergeBaseTree = parseCommit(baseObj.data).tree;
  const headTree = parseCommit(headObj.data).tree;
  const tipTree = parseCommit(tipObj.data).tree;
  const mergeBase = treeWalkFiles(repo.objects, mergeBaseTree);
  const head = treeWalkFiles(repo.objects, headTree);
  let newTree = tipTree;
  const paths = new Set([...mergeBase.keys(), ...head.keys()]);
  for (const path of paths) {
    const m = mergeBase.get(path);
    const h = head.get(path);
    if (m === h) continue;
    newTree = treeSet(repo.objects, newTree, path.split('/'), h ?? null);
  }
  const message = `Merge pull request #${pr.number} from ${repo.owner}/${pr.headRef}\n\n${pr.title}`;
  const sha = store.createCommit(repo, pr.baseRef, newTree, message, [baseTip]);
  return { ok: true, sha };
}

// ---------------------------------------------------------------- handlers

export function getRoot(): RestResult {
  return ok(200, {
    current_user_url: '/api/v3/user',
    current_user_authorizations_html_url: '/settings/applications',
    authorizations_url: '/api/v3/authorizations',
    rate_limit_url: '/api/v3/rate_limit',
    repository_url: '/api/v3/repos/{owner}/{repo}',
  });
}

export function getMeta(): RestResult {
  return ok(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
}

export function getUser(): RestResult {
  return ok(200, userView(VIEWER.login));
}

export function listUserRepos(store: Store, query: Query, origin: string): RestResult {
  const repos = store.listRepos(VIEWER.login).map((r) => repoView(r, origin));
  const { page, link } = paginate(repos, query, origin, '/api/v3/user/repos');
  return ok(200, page, link);
}

export function createUserRepo(store: Store, body: Record<string, unknown>, origin: string): RestResult {
  const name = typeof body.name === 'string' ? body.name : '';
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) {
    return unprocessable('Validation Failed: name is invalid');
  }
  const description = typeof body.description === 'string' ? body.description : '';
  const privateFlag = body.private === true;
  const repo = store.createRepo(VIEWER.login, name, description, privateFlag);
  if (!repo) return unprocessable(`name already exists on this account`);
  return ok(201, repoView(repo, origin));
}

export function getRepo(store: Store, owner: string, name: string, origin: string): RestResult {
  const repo = requireRepo(store, owner, name);
  if (!repo) return notFound('Not Found');
  return ok(200, repoView(repo, origin));
}

export function patchRepo(store: Store, owner: string, name: string, body: Record<string, unknown>, origin: string): RestResult {
  const repo = requireRepo(store, owner, name);
  if (!repo) return notFound('Not Found');
  if (typeof body.description === 'string') repo.description = body.description;
  if (body.private === true || body.private === false) repo.privateFlag = body.private;
  return ok(200, repoView(repo, origin));
}

export function deleteRepo(store: Store, owner: string, name: string): RestResult {
  const repo = requireRepo(store, owner, name);
  if (!repo) return notFound('Not Found');
  store.deleteRepo(owner, name);
  return { status: 204, json: null };
}

export function listBranches(store: Store, owner: string, name: string): RestResult {
  const repo = requireRepo(store, owner, name);
  if (!repo) return notFound('Not Found');
  const branches = [...repo.refs.keys()]
    .filter((r) => r.startsWith('refs/heads/'))
    .map((r) => r.slice('refs/heads/'.length))
    .sort()
    .map((branch) => ({
      name: branch,
      commit: { sha: repo.refs.get(`refs/heads/${branch}`) ?? '', url: '' },
      protected: false,
    }));
  return ok(200, branches);
}

export function getBranch(store: Store, owner: string, name: string, branch: string): RestResult {
  const repo = requireRepo(store, owner, name);
  if (!repo) return notFound('Not Found');
  const sha = repo.refs.get(`refs/heads/${branch}`);
  if (!sha) return notFound('Branch not found');
  return ok(200, { name: branch, commit: { sha, url: '' }, protected: false });
}

export function getRef(store: Store, owner: string, name: string, ref: string): RestResult {
  const repo = requireRepo(store, owner, name);
  if (!repo) return notFound('Not Found');
  const sha = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`);
  if (!sha) return notFound('Not Found');
  const obj = repo.objects.get(sha);
  return ok(200, {
    ref,
    node_id: Buffer.from(`Ref:${ref}`).toString('base64'),
    url: '',
    object: { sha, type: obj?.type ?? 'commit', url: '' },
  });
}

export function createRef(store: Store, owner: string, name: string, body: Record<string, unknown>): RestResult {
  const repo = requireRepo(store, owner, name);
  if (!repo) return notFound('Not Found');
  const ref = typeof body.ref === 'string' ? body.ref : '';
  const sha = typeof body.sha === 'string' ? body.sha : '';
  if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) {
    return unprocessable('Validation Failed: ref and sha are required');
  }
  if (repo.refs.has(ref)) return unprocessable('Reference already exists');
  const obj = repo.objects.get(sha);
  if (!obj) return unprocessable('Object does not exist');
  repo.refs.set(ref, sha);
  return ok(201, {
    ref,
    node_id: Buffer.from(`Ref:${ref}`).toString('base64'),
    url: '',
    object: { sha, type: obj.type, url: '' },
  });
}

export function listCommits(store: Store, owner: string, name: string, query: Query): RestResult {
  const repo = requireRepo(store, owner, name);
  if (!repo) return notFound('Not Found');
  const ref = typeof query.sha === 'string' ? query.sha : repo.defaultBranch;
  const start = store.resolveCommit(repo, ref);
  if (!start) return notFound('Not Found');
  const history = store.commitHistory(repo, start);
  const views = history
    .map((sha) => commitView(repo, sha))
    .filter((v): v is Record<string, unknown> => v !== null);
  const { page } = paginate(views, query, '', '');
  return ok(200, page);
}

export function getCommit(store: Store, owner: string, name: string, sha: string): RestResult {
  const repo = requireRepo(store, owner, name);
  if (!repo) return notFound('Not Found');
  const view = commitView(repo, sha);
  if (!view) return notFound('Not Found');
  return ok(200, view);
}

export function putContents(
  store: Store,
  owner: string,
  name: string,
  path: string,
  body: Record<string, unknown>,
): RestResult {
  const repo = requireRepo(store, owner, name);
  if (!repo) return notFound('Not Found');
  const message = typeof body.message === 'string' ? body.message : 'Update file';
  const contentB64 = typeof body.content === 'string' ? body.content : '';
  const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
  const expectedSha = typeof body.sha === 'string' ? body.sha : null;
  let content: Buffer;
  try {
    content = Buffer.from(contentB64, 'base64');
  } catch {
    return unprocessable('Validation Failed: content must be base64');
  }
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  const baseTree = tip ? parseCommit((repo.objects.get(tip) as { data: Buffer }).data).tree : emptyTreeOid(repo.objects);
  const existing = treeGet(repo.objects, baseTree, path.split('/'));
  if (expectedSha !== null) {
    if (!existing || existing.oid !== expectedSha) {
      return conflict('sha does not match the current blob');
    }
  }
  const isUpdate = existing !== null;
  const { commitOid, blobOid } = store.putFile(repo, branch, path, content, message);
  const status = isUpdate ? 200 : 201;
  return ok(status, {
    content: {
      name: path.split('/').pop() ?? '',
      path,
      sha: blobOid,
      size: content.length,
      url: '',
      html_url: '',
      git_url: '',
      download_url: null,
      type: 'file',
      encoding: 'base64',
      content: contentB64,
      _links: {},
    },
    commit: { sha: commitOid, message, url: '' },
  });
}

export function getContents(
  store: Store,
  owner: string,
  name: string,
  path: string,
  query: Query,
): RestResult {
  const repo = requireRepo(store, owner, name);
  if (!repo) return notFound('Not Found');
  const ref = typeof query.ref === 'string' ? query.ref : repo.defaultBranch;
  const start = store.resolveCommit(repo, ref);
  if (!start) return notFound('Not Found');
  const treeOid = parseCommit((repo.objects.get(start) as { data: Buffer }).data).tree;
  const segments = path === '' ? [] : path.split('/');
  if (segments.length === 0) {
    const entries = treeList(repo.objects, treeOid, []) ?? [];
    return ok(200, entries.map((e) => dirEntryView(repo, e, '')));
  }
  const found = treeGet(repo.objects, treeOid, segments);
  if (!found) return notFound('Not Found');
  if (found.type === 'tree') {
    const entries = treeList(repo.objects, treeOid, segments) ?? [];
    return ok(200, entries.map((e) => dirEntryView(repo, e, path)));
  }
  const obj = repo.objects.get(found.oid);
  if (!obj) return notFound('Not Found');
  return ok(200, {
    type: 'file',
    encoding: 'base64',
    size: obj.data.length,
    name: segments[segments.length - 1] ?? '',
    path,
    content: obj.data.toString('base64'),
    sha: found.oid,
    url: '',
    html_url: '',
    git_url: '',
    download_url: null,
    _links: {},
  });
}

function dirEntryView(repo: Repo, entry: { mode: string; name: string; oid: string }, parentPath: string): Record<string, unknown> {
  const isDir = entry.mode === '40000';
  const path = parentPath ? `${parentPath}/${entry.name}` : entry.name;
  const obj = repo.objects.get(entry.oid);
  return {
    type: isDir ? 'dir' : 'file',
    size: isDir ? 0 : (obj?.data.length ?? 0),
    name: entry.name,
    path,
    sha: entry.oid,
    url: '',
    html_url: '',
    git_url: '',
    download_url: null,
    _links: {},
  };
}

export function deleteContents(
  store: Store,
  owner: string,
  name: string,
  path: string,
  body: Record<string, unknown>,
): RestResult {
  const repo = requireRepo(store, owner, name);
  if (!repo) return notFound('Not Found');
  const message = typeof body.message === 'string' ? body.message : 'Delete file';
  const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
  const sha = store.deleteFile(repo, branch, path, message);
  if (!sha) return notFound('Not Found');
  return ok(200, { commit: { sha, message, url: '' } });
}

export function listLabels(store: Store, owner: string, name: string): RestResult {
  const repo = requireRepo(store, owner, name);
  if (!repo) return notFound('Not Found');
  return ok(200, [...repo.labels.values()].map(labelView));
}

export function createLabel(store: Store, owner: string, name: string, body: Record<string, unknown>): RestResult {
  const repo = requireRepo(store, owner, name);
  if (!repo) return notFound('Not Found');
  const labelName = typeof body.name === 'string' ? body.name : '';
  if (!labelName) return unprocessable('Validation Failed: name is required');
  const color = typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed';
  const existing = repo.labels.get(labelName);
  if (existing) return ok(201, labelView(existing));
  const label: Label = { name: labelName, color };
  repo.labels.set(labelName, label);
  return ok(201, labelView(label));
}

export function createIssue(store: Store, owner: string, name: string, body: Record<string, unknown>): RestResult {
  const repo = requireRepo(store, owner, name);
  if (!repo) return notFound('Not Found');
  const title = typeof body.title === 'string' ? body.title : '';
  if (!title) return unprocessable('Validation Failed: title is required');
  const labelNames = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
  const labels: Label[] = [];
  for (const labelName of labelNames) {
    const label = repo.labels.get(labelName);
    if (!label) return unprocessable(`Validation Failed: label "${labelName}" does not exist`);
    labels.push(label);
  }
  store.seq += 1;
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const issue: Issue = {
    id: 100000 + number,
    number,
    title,
    body: typeof body.body === 'string' ? body.body : '',
    state: 'open',
    labels,
    userLogin: VIEWER.login,
    createdSeq: store.seq,
    comments: [],
  };
  repo.issues.set(number, issue);
  return ok(201, issueView(issue, repo));
}

export function listIssues(store: Store, owner: string, name: string, query: Query): RestResult {
  const repo = requireRepo(store, owner, name);
  if (!repo) return notFound('Not Found');
  const state = query.state ?? 'open';
  let issues = [...repo.issues.values()];
  if (state !== 'all') issues = issues.filter((i) => i.state === state);
  const direction = query.direction ?? 'desc';
  issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  const { page } = paginate(issues.map((i) => issueView(i, repo)), query, '', '');
  return ok(200, page);
}

export function getIssue(store: Store, owner: string, name: string, number: number): RestResult {
  const repo = requireRepo(store, owner, name);
  if (!repo) return notFound('Not Found');
  const issue = repo.issues.get(number);
  if (!issue) return notFound('Not Found');
  return ok(200, issueView(issue, repo));
}

export function patchIssue(store: Store, owner: string, name: string, number: number, body: Record<string, unknown>): RestResult {
  const repo = requireRepo(store, owner, name);
  if (!repo) return notFound('Not Found');
  const issue = repo.issues.get(number);
  if (!issue) return notFound('Not Found');
  if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  return ok(200, issueView(issue, repo));
}

export function listComments(store: Store, owner: string, name: string, number: number): RestResult {
  const repo = requireRepo(store, owner, name);
  if (!repo) return notFound('Not Found');
  const issue = repo.issues.get(number);
  if (!issue) return notFound('Not Found');
  return ok(200, issue.comments.map((c) => commentView(c, repo, number)));
}

export function createComment(store: Store, owner: string, name: string, number: number, body: Record<string, unknown>): RestResult {
  const repo = requireRepo(store, owner, name);
  if (!repo) return notFound('Not Found');
  const issue = repo.issues.get(number);
  if (!issue) return notFound('Not Found');
  const text = typeof body.body === 'string' ? body.body : '';
  if (!text) return unprocessable('Validation Failed: body is required');
  const comment = { id: repo.nextCommentId, body: text, userLogin: VIEWER.login };
  repo.nextCommentId += 1;
  issue.comments.push(comment);
  return ok(201, commentView(comment, repo, number));
}

export function createPull(store: Store, owner: string, name: string, body: Record<string, unknown>): RestResult {
  const repo = requireRepo(store, owner, name);
  if (!repo) return notFound('Not Found');
  const title = typeof body.title === 'string' ? body.title : '';
  const head = typeof body.head === 'string' ? body.head : '';
  const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
  if (!title || !head) return unprocessable('Validation Failed: title and head are required');
  const headTip = repo.refs.get(`refs/heads/${head}`);
  const baseTip = repo.refs.get(`refs/heads/${base}`);
  if (!headTip || !baseTip) return unprocessable('Validation Failed: head or base branch does not exist');
  for (const pr of repo.pulls.values()) {
    if (pr.state === 'open' && pr.headRef === head && pr.baseRef === base) {
      return unprocessable('A pull request already exists for this head branch');
    }
  }
  store.seq += 1;
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const pr: PullRequest = {
    id: 200000 + number,
    number,
    title,
    body: typeof body.body === 'string' ? body.body : '',
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: head,
    baseRef: base,
    baseSha: baseTip,
    userLogin: VIEWER.login,
    createdSeq: store.seq,
  };
  repo.pulls.set(number, pr);
  return ok(201, pullView(pr, repo));
}

export function listPulls(store: Store, owner: string, name: string, query: Query): RestResult {
  const repo = requireRepo(store, owner, name);
  if (!repo) return notFound('Not Found');
  const state = query.state ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state !== 'all') pulls = pulls.filter((p) => p.state === state);
  pulls.sort((a, b) => b.createdSeq - a.createdSeq);
  const { page } = paginate(pulls.map((p) => pullView(p, repo)), query, '', '');
  return ok(200, page);
}

export function getPull(store: Store, owner: string, name: string, number: number): RestResult {
  const repo = requireRepo(store, owner, name);
  if (!repo) return notFound('Not Found');
  const pr = repo.pulls.get(number);
  if (!pr) return notFound('Not Found');
  return ok(200, pullView(pr, repo));
}

export function listPullFiles(store: Store, owner: string, name: string, number: number): RestResult {
  const repo = requireRepo(store, owner, name);
  if (!repo) return notFound('Not Found');
  const pr = repo.pulls.get(number);
  if (!pr) return notFound('Not Found');
  const baseObj = repo.objects.get(pr.baseSha);
  const headTip = branchTipSha(repo, pr.headRef);
  if (!baseObj || !headTip) return notFound('Not Found');
  const baseTree = parseCommit(baseObj.data).tree;
  const headTree = parseCommit((repo.objects.get(headTip) as { data: Buffer }).data).tree;
  return ok(200, diffFiles(repo, baseTree, headTree));
}

export function mergePull(store: Store, owner: string, name: string, number: number, body: Record<string, unknown>): RestResult {
  const repo = requireRepo(store, owner, name);
  if (!repo) return notFound('Not Found');
  const pr = repo.pulls.get(number);
  if (!pr) return notFound('Not Found');
  if (pr.state !== 'open' || pr.merged) {
    return methodNotAllowed('Pull request is already closed');
  }
  const mergeMethod = typeof body.merge_method === 'string' ? body.merge_method : 'squash';
  void mergeMethod;
  const result = squashMerge(store, repo, pr);
  if (result.conflict) {
    return methodNotAllowed('Merge conflict');
  }
  if (!result.ok || !result.sha) {
    return methodNotAllowed('Pull request cannot be merged');
  }
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = FIXED_DATE;
  pr.mergeCommitSha = result.sha;
  return ok(200, {
    merged: true,
    sha: result.sha,
    message: `Pull request #${pr.number} merged`,
  });
}
