// store.ts — in-memory forge store: git object model, repo/issue/PR state, pack codec.
// Everything deterministic: no wall-clock time, no randomness. Server-made commits use a
// monotonic counter as their timestamp, so two runs on the same instance export identical
// state byte-for-byte.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { VIEWER, DEFAULT_BRANCH } from './scenario.ts';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function storeObject(objects: Map<string, GitObject>, type: ObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

// ---------------------------------------------------------------- commits

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(tree: string, parents: string[], message: string, ident: string): Buffer {
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${ident}`, `committer ${ident}`, '', message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** Deterministic identity line for server-made commits. */
export function serverIdent(seq: number): string {
  return `${VIEWER.name} <${VIEWER.email}> ${1700000000 + seq} +0000`;
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0, space + 1);
    const mode = data.toString('utf8', offset, space);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function gitTreeCompare(a: string, b: string): number {
  // Git sorts tree entries as if directory names were suffixed with '/'.
  const x = a.endsWith('/') ? a : a;
  const y = b.endsWith('/') ? b : b;
  return x < y ? -1 : x > y ? 1 : 0;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function emptyTreeOid(objects: Map<string, GitObject>): string {
  return storeObject(objects, 'tree', Buffer.alloc(0));
}

/** Resolve a path inside a tree. Returns null when absent. */
export function treeGet(
  objects: Map<string, GitObject>,
  treeOid: string,
  segments: string[],
): { type: ObjectType; oid: string; mode: string } | null {
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const obj = objects.get(current);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) {
      const type = entry.mode === '40000' ? 'tree' : entry.mode === '160000' ? 'commit' : 'blob';
      return { type, oid: entry.oid, mode: entry.mode };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/** List the entries of a directory inside a tree (empty segments = root). */
export function treeList(
  objects: Map<string, GitObject>,
  treeOid: string,
  segments: string[],
): TreeEntry[] | null {
  let current = treeOid;
  for (const seg of segments) {
    const obj = objects.get(current);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === seg);
    if (!entry || entry.mode !== '40000') return null;
    current = entry.oid;
  }
  const obj = objects.get(current);
  if (!obj || obj.type !== 'tree') return null;
  return parseTree(obj.data);
}

/** Set (or delete with blobOid null) one path in a tree; returns the new tree oid. */
export function treeSet(
  objects: Map<string, GitObject>,
  treeOid: string,
  segments: string[],
  blobOid: string | null,
): string {
  if (segments.length === 0) return treeOid;
  const entries = treeOid === EMPTY_TREE_OID || !objects.has(treeOid)
    ? []
    : parseTree((objects.get(treeOid) as GitObject).data);
  const [head, ...rest] = segments as [string, ...string[]];
  const idx = entries.findIndex((e) => e.name === head);
  if (rest.length === 0) {
    if (blobOid === null) {
      if (idx >= 0) entries.splice(idx, 1);
    } else {
      const entry: TreeEntry = { mode: '100644', name: head, oid: blobOid };
      if (idx >= 0) entries[idx] = entry;
      else entries.push(entry);
    }
  } else {
    const childOid = idx >= 0 && entries[idx]?.mode === '40000'
      ? (entries[idx] as TreeEntry).oid
      : EMPTY_TREE_OID;
    const newChild = treeSet(objects, childOid, rest, blobOid);
    const childObj = objects.get(newChild);
    const childEmpty = !childObj || (childObj.type === 'tree' && childObj.data.length === 0);
    if (childEmpty) {
      if (idx >= 0) entries.splice(idx, 1);
    } else {
      const entry: TreeEntry = { mode: '40000', name: head, oid: newChild };
      if (idx >= 0) entries[idx] = entry;
      else entries.push(entry);
    }
  }
  if (entries.length === 0) return EMPTY_TREE_OID;
  return storeObject(objects, 'tree', buildTree(entries));
}

/** Recursively list all file paths in a tree: path -> blob oid. */
export function treeWalkFiles(
  objects: Map<string, GitObject>,
  treeOid: string,
  prefix = '',
  out: Map<string, string> = new Map(),
): Map<string, string> {
  const obj = objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '40000') treeWalkFiles(objects, entry.oid, path, out);
    else if (entry.mode !== '160000') out.set(path, entry.oid);
  }
  return out;
}

// ---------------------------------------------------------------- reachability

/** Peel a tag object chain to its target oid (non-tag oid returned as-is). */
export function peelToNonTag(objects: Map<string, GitObject>, oid: string): string {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const obj = objects.get(current);
    if (!obj || obj.type !== 'tag') return current;
    const text = obj.data.toString('utf8');
    const m = /^object ([0-9a-f]{40})$/m.exec(text);
    if (!m) return current;
    current = m[1] as string;
  }
  return current;
}

/**
 * All objects reachable from `starts`. Commits in `stopAt` are included with their
 * trees/blobs but their parents are not traversed (shallow boundaries).
 */
export function reachableObjects(
  objects: Map<string, GitObject>,
  starts: readonly string[],
  stopAt: ReadonlySet<string> = new Set(),
): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const queue: string[] = [...starts];
  const seenCommits = new Set<string>();
  const visitTree = (treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      const obj = objects.get(oid);
      if (!obj || out.has(oid)) continue;
      out.set(oid, obj);
      if (obj.type !== 'tree') continue;
      for (const entry of parseTree(obj.data)) {
        if (entry.mode === '40000') stack.push(entry.oid);
        else if (entry.mode !== '160000') {
          const child = objects.get(entry.oid);
          if (child && !out.has(entry.oid)) out.set(entry.oid, child);
        }
      }
    }
  };
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    const obj = objects.get(oid);
    if (!obj || out.has(oid)) continue;
    out.set(oid, obj);
    if (obj.type === 'tag') {
      const target = peelToNonTag(objects, oid);
      if (target !== oid) queue.push(target);
      continue;
    }
    if (obj.type !== 'commit') continue;
    if (seenCommits.has(oid)) continue;
    seenCommits.add(oid);
    const info = parseCommit(obj.data);
    visitTree(info.tree);
    if (!stopAt.has(oid)) {
      for (const parent of info.parents) queue.push(parent);
    }
  }
  return out;
}

/** BFS commit distances from `starts` (peeled), capped at maxDepth (inclusive). */
export function bfsCommitLevels(
  objects: Map<string, GitObject>,
  starts: readonly string[],
  maxDepth: number,
): Map<string, number> {
  const levels = new Map<string, number>();
  const queue: Array<[string, number]> = [];
  for (const start of starts) {
    const peeled = peelToNonTag(objects, start);
    const obj = objects.get(peeled);
    if (obj && obj.type === 'commit' && !levels.has(peeled)) {
      levels.set(peeled, 0);
      queue.push([peeled, 0]);
    }
  }
  let head = 0;
  while (head < queue.length) {
    const [oid, depth] = queue[head] as [string, number];
    head += 1;
    if (depth >= maxDepth) continue;
    const obj = objects.get(oid);
    if (!obj) continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (!levels.has(parent)) {
        levels.set(parent, depth + 1);
        queue.push([parent, depth + 1]);
      }
    }
  }
  return levels;
}

// ---------------------------------------------------------------- pack codec

const PACK_OBJECT_TYPES: Record<number, ObjectType> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};

function packObjectTypeCode(type: ObjectType): number {
  return type === 'commit' ? 1 : type === 'tree' ? 2 : type === 'blob' ? 3 : 4;
}

function writePackObjectHeader(type: ObjectType, size: number): Buffer {
  const typeCode = packObjectTypeCode(type);
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let next = size & 0x7f;
    size >>= 7;
    if (size > 0) next |= 0x80;
    bytes.push(next);
  }
  return Buffer.from(bytes);
}

/** Serialize objects as a packfile v2 (plain objects only, no deltas). */
export function writePack(objects: ReadonlyMap<string, GitObject>): Buffer {
  const entries = [...objects.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  parts.push(header);
  const trailerHash = createHash('sha1');
  trailerHash.update(header);
  for (const [oid, obj] of entries) {
    const oh = writePackObjectHeader(obj.type, obj.data.length);
    const deflated = deflateSync(obj.data);
    trailerHash.update(oh);
    trailerHash.update(deflated);
    parts.push(oh, deflated);
  }
  const trailer = trailerHash.digest();
  parts.push(trailer);
  return Buffer.concat(parts);
}

export interface ReadPackResult {
  objects: Map<string, GitObject>;
}

/** Parse a packfile v2; throws on a bad header, bad zlib data or a bad trailer. */
export function readPack(buffer: Buffer): ReadPackResult {
  if (buffer.length < 32) throw new Error('pack too short');
  if (buffer.toString('ascii', 0, 4) !== 'PACK') throw new Error('bad pack magic');
  if (buffer.readUInt32BE(4) !== 2) throw new Error('unsupported pack version');
  const count = buffer.readUInt32BE(8);
  const expectedTrailer = createHash('sha1').update(buffer.subarray(0, buffer.length - 20)).digest();
  const actualTrailer = buffer.subarray(buffer.length - 20);
  if (!expectedTrailer.equals(actualTrailer)) throw new Error('bad pack trailer');
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, string>();
  let offset = 12;
  const end = buffer.length - 20;
  let lastCompressedLength = 64;
  for (let i = 0; i < count; i += 1) {
    const startOffset = offset;
    let byte = buffer[offset] as number;
    offset += 1;
    const typeCode = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buffer[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeCode === 6) {
      // OFS_DELTA: not produced by our client; refuse.
      throw new Error('ofs-delta packs are not supported');
    }
    if (typeCode === 7) throw new Error('ref-delta packs are not supported');
    const type = PACK_OBJECT_TYPES[typeCode];
    if (!type) throw new Error(`unknown pack object type ${typeCode}`);
    const inflated = inflateSync(buffer.subarray(offset));
    if (inflated.length !== size) throw new Error('object size mismatch');
    const consumed = inflateSyncLength(buffer, offset, lastCompressedLength);
    lastCompressedLength = consumed;
    offset += consumed;
    const oid = hashObject(type, inflated);
    objects.set(oid, { type, data: inflated });
    byOffset.set(startOffset, oid);
  }
  if (offset !== end) throw new Error('pack length mismatch');
  return { objects };
}

/** Number of compressed bytes consumed by inflating from `offset` (zlib deflate stream).
 * inflateSync ignores trailing bytes but throws on truncation, so "inflates cleanly"
 * is monotone in the slice end. `hint` (the previous object's compressed length; objects
 * in a pack are usually similar in size) seeds the search so the common case needs only
 * a short binary search. */
function inflateSyncLength(buffer: Buffer, offset: number, hint: number): number {
  const cap = buffer.length - 20 - offset; // pack trailer is 20 bytes
  const succeeds = (len: number): boolean => {
    try {
      inflateSync(buffer.subarray(offset, offset + len));
      return true;
    } catch {
      return false;
    }
  };
  let guess = Math.max(8, Math.min(hint, cap));
  if (succeeds(guess)) {
    // The stream ends at or before the hint: binary-search the first succeeding length.
    let lo = 8;
    let hi = guess;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (succeeds(mid)) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }
  // The stream is longer than the hint: grow exponentially, then binary-search the bracket.
  while (guess < cap && !succeeds(guess)) guess = Math.min(cap, guess * 2);
  if (guess >= cap) {
    if (!succeeds(cap)) throw new Error('deflate stream runs past the pack end');
    guess = cap;
  }
  let lo = Math.floor(guess / 2);
  let hi = guess;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (succeeds(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

// ---------------------------------------------------------------- pkt-lines

export function pktLine(text: string): Buffer {
  const body = Buffer.from(text, 'utf8');
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Decode pkt-lines; returns lines (strings) and the byte offset where the pack begins. */
export function decodePktLines(buffer: Buffer): { lines: string[]; packOffset: number } {
  const lines: string[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const len = parseInt(buffer.toString('ascii', offset, offset + 4), 16);
    if (Number.isNaN(len)) throw new Error('invalid pkt-line length');
    if (len === 0) {
      offset += 4;
      break;
    }
    if (len === 1 || len === 2) {
      offset += 4;
      continue;
    }
    if (offset + len > buffer.length) throw new Error('truncated pkt-line');
    lines.push(buffer.toString('utf8', offset + 4, offset + len));
    offset += len;
  }
  return { lines, packOffset: offset };
}

// ---------------------------------------------------------------- repo model

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  userLogin: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  userLogin: string;
  createdSeq: number;
  comments: IssueComment[];
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  baseSha: string;
  userLogin: string;
  createdSeq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  privateFlag: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  labels: Map<string, Label>;
  nextNumber: number;
  nextCommentId: number;
  createdSeq: number;
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  seq = 0;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, description: string, privateFlag: boolean): Repo | null {
    const key = this.key(owner, name);
    if (this.repos.has(key)) return null;
    this.seq += 1;
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner,
      description,
      privateFlag,
      defaultBranch: DEFAULT_BRANCH,
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      createdSeq: this.seq,
    };
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    return [...this.repos.values()]
      .filter((r) => r.owner === owner)
      .sort((a, b) => a.createdSeq - b.createdSeq);
  }

  /** Create a commit on `branch` (parents = current tip, or [] when unborn). */
  createCommit(repo: Repo, branch: string, treeOid: string, message: string, parents?: string[]): string {
    this.seq += 1;
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    const parentList = parents ?? (tip ? [tip] : []);
    const data = buildCommit(treeOid, parentList, message, serverIdent(this.seq));
    const oid = storeObject(repo.objects, 'commit', data);
    repo.refs.set(ref, oid);
    return oid;
  }

  /** Set one file on a branch, creating the branch from the default tip when missing. */
  putFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
  ): { commitOid: string; blobOid: string } {
    const ref = `refs/heads/${branch}`;
    if (!repo.refs.has(ref)) {
      const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (defaultTip) repo.refs.set(ref, defaultTip);
    }
    const tip = repo.refs.get(ref);
    const baseTree = tip ? parseCommit((repo.objects.get(tip) as GitObject).data).tree : EMPTY_TREE_OID;
    const blobOid = storeObject(repo.objects, 'blob', content);
    const newTree = treeSet(repo.objects, baseTree, path.split('/'), blobOid);
    const commitOid = this.createCommit(repo, branch, newTree, message);
    return { commitOid, blobOid };
  }

  deleteFile(repo: Repo, branch: string, path: string, message: string): string | null {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    if (!tip) return null;
    const baseTree = parseCommit((repo.objects.get(tip) as GitObject).data).tree;
    const existing = treeGet(repo.objects, baseTree, path.split('/'));
    if (!existing) return null;
    const newTree = treeSet(repo.objects, baseTree, path.split('/'), null);
    return this.createCommit(repo, branch, newTree, message);
  }

  /** Resolve a ref name or oid to a commit oid, or null. */
  resolveCommit(repo: Repo, refOrOid: string): string | null {
    if (/^[0-9a-f]{40}$/.test(refOrOid)) {
      const obj = repo.objects.get(refOrOid);
      if (!obj) return null;
      return obj.type === 'commit' ? refOrOid : obj.type === 'tag' ? peelToNonTag(repo.objects, refOrOid) : null;
    }
    const tip = repo.refs.get(`refs/heads/${refOrOid}`) ?? repo.refs.get(refOrOid);
    if (!tip) return null;
    const obj = repo.objects.get(tip);
    if (!obj) return null;
    return obj.type === 'commit' ? tip : peelToNonTag(repo.objects, tip);
  }

  /** First-parent walk from a commit, newest first. */
  commitHistory(repo: Repo, startOid: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    let current: string | null = startOid;
    while (current && !seen.has(current)) {
      seen.add(current);
      out.push(current);
      const obj = repo.objects.get(current);
      if (!obj || obj.type !== 'commit') break;
      const parents = parseCommit(obj.data).parents;
      current = parents.length > 0 ? (parents[0] as string) : null;
    }
    return out;
  }
}
