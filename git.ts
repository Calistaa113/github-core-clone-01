// git.ts — Git smart-HTTP: v0/v2 advertisements, v2 ls-refs/fetch, receive-pack.
// Protocol facts are taken from the kit's git-client.ts, not from memory.

import {
  ZERO_OID,
  decodePktLines,
  hashObject,
  parseCommit,
  peelToNonTag,
  pktDelim,
  pktFlush,
  pktLine,
  reachableObjects,
  bfsCommitLevels,
  readPack,
  writePack,
  type GitObject,
  type Repo,
} from './store.ts';

export interface GitResult {
  status: number;
  contentType: string;
  body: Buffer;
}

const AGENT = 'forge/1.0';
const UPLOAD_PACK_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_PACK_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_PACK_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_PACK_RESULT = 'application/x-git-receive-pack-result';

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

/** All refs of a repo, HEAD first, then sorted by name. */
function listRefs(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const tip = repo.refs.get(defaultRef);
  if (tip) {
    out.push({ oid: tip, name: 'HEAD', symrefTarget: defaultRef });
  } else {
    out.push({ oid: ZERO_OID, name: 'HEAD', symrefTarget: defaultRef, unborn: true });
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const obj = repo.objects.get(oid);
    const entry: RefLine = { oid, name };
    if (obj && obj.type === 'tag') entry.peeled = peelToNonTag(repo.objects, oid);
    out.push(entry);
  }
  return out;
}

function isTagRef(repo: Repo, ref: RefLine): boolean {
  const obj = repo.objects.get(ref.oid);
  return !!obj && obj.type === 'tag';
}

// ---------------------------------------------------------------- info/refs

export function infoRefsUploadPack(repo: Repo, gitProtocol: string | null): GitResult {
  const refs = listRefs(repo);
  if (gitProtocol === 'version=2') {
    const parts: Buffer[] = [
      pktLine('version 2\n'),
      pktLine(`agent=${AGENT}\n`),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow\n'),
      pktLine('object-format=sha1\n'),
      pktFlush(),
    ];
    return { status: 200, contentType: UPLOAD_PACK_AD, body: Buffer.concat(parts) };
  }
  const caps = `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k ofs-delta thin-pack multi_ack shallow agent=${AGENT}`;
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), pktFlush()];
  if (refs.length === 1 && refs[0]?.unborn) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\0${caps}` : '';
      parts.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
      if (ref.peeled && isTagRef(repo, ref)) {
        parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
      }
    });
  }
  parts.push(pktFlush());
  return { status: 200, contentType: UPLOAD_PACK_AD, body: Buffer.concat(parts) };
}

export function infoRefsReceivePack(repo: Repo): GitResult {
  // Receive-pack is v0 only: the client throws when the advertisement is not protocol 0.
  const refs = listRefs(repo);
  const caps = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), pktFlush()];
  if (refs.length === 1 && refs[0]?.unborn) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\0${caps}` : '';
      parts.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
      if (ref.peeled && isTagRef(repo, ref)) {
        parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
      }
    });
  }
  parts.push(pktFlush());
  return { status: 200, contentType: RECEIVE_PACK_AD, body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------- v2 upload-pack

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseV2Args(lines: string[]): FetchArgs {
  const args: FetchArgs = {
    wants: [],
    haves: [],
    shallow: [],
    depth: null,
    peel: false,
    symrefs: false,
    unborn: false,
    prefixes: [],
  };
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) args.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) args.depth = parseInt(text.slice(7), 10);
    else if (text === 'peel') args.peel = true;
    else if (text === 'symrefs') args.symrefs = true;
    else if (text === 'unborn') args.unborn = true;
    else if (text.startsWith('ref-prefix ')) args.prefixes.push(text.slice(11));
  }
  return args;
}

function lsRefsResponse(repo: Repo, args: FetchArgs): Buffer {
  const refs = listRefs(repo);
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    if (ref.unborn) {
      // Only an unborn HEAD line: an unborn refs/heads/* line would make an empty repo
      // look non-empty to the client.
      if (args.unborn || ref.name === 'HEAD') {
        const sym = args.symrefs && ref.symrefTarget ? ` symref-target:${ref.symrefTarget}` : '';
        parts.push(pktLine(`unborn ${ref.name}${sym}\n`));
      }
      continue;
    }
    let line = `${ref.oid} ${ref.name}`;
    if (args.symrefs && ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
    if (args.peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

interface FetchPlan {
  objects: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
}

function computeFetch(repo: Repo, args: FetchArgs): FetchPlan {
  const shallowReq = new Set(args.shallow);
  const held = reachableObjects(repo.objects, args.haves, shallowReq);
  if (args.depth !== null && args.depth > 0) {
    const levels = bfsCommitLevels(repo.objects, args.wants, args.depth - 1);
    const boundary = new Set<string>();
    for (const [oid, depth] of levels) {
      if (depth === args.depth - 1) boundary.add(oid);
    }
    const full = reachableObjects(repo.objects, args.wants, boundary);
    const sent = new Map<string, GitObject>();
    for (const [oid, obj] of full) {
      if (!held.has(oid)) sent.set(oid, obj);
    }
    const shallow = [...boundary].sort();
    const unshallow = [...shallowReq].filter((o) => !boundary.has(o) && full.has(o)).sort();
    return { objects: sent, shallow, unshallow };
  }
  const full = reachableObjects(repo.objects, args.wants, shallowReq);
  const sent = new Map<string, GitObject>();
  for (const [oid, obj] of full) {
    if (!held.has(oid)) sent.set(oid, obj);
  }
  return { objects: sent, shallow: [], unshallow: [] };
}

function fetchResponse(repo: Repo, args: FetchArgs): Buffer {
  const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), pktDelim()];
  // Missing wants: report a sideband error instead of an empty pack.
  const missing = args.wants.filter((w) => !repo.objects.has(w));
  if (missing.length > 0) {
    const err = Buffer.from('object not found\n', 'utf8');
    const packet = Buffer.concat([Buffer.from([3]), err]);
    parts.push(pktLine('packfile\n'));
    parts.push(pktLineRaw(packet));
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  const plan = computeFetch(repo, args);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  if (plan.objects.size > 0) {
    const pack = writePack(plan.objects);
    parts.push(pktLine('packfile\n'));
    const CHUNK = 65515;
    for (let offset = 0; offset < pack.length; offset += CHUNK) {
      const slice = pack.subarray(offset, Math.min(offset + CHUNK, pack.length));
      const packet = Buffer.concat([Buffer.from([1]), slice]);
      parts.push(pktLineRaw(packet));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function pktLineRaw(payload: Buffer): Buffer {
  const len = payload.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), payload]);
}

export function uploadPack(repo: Repo, body: Buffer): GitResult {
  let lines: string[];
  try {
    ({ lines } = decodePktLines(body));
  } catch {
    return { status: 400, contentType: 'application/json', body: Buffer.from('{"message":"Bad Request"}\n') };
  }
  const command = (lines[0] ?? '').replace(/\n$/, '');
  // Request shape: command + optional agent=/object-format= lines + delim + args + flush.
  // decodePktLines already drops delim/flush packets; agent/object-format lines are ignored
  // by parseV2Args, so the arguments are simply everything after the command line.
  const argLines = lines.slice(1);
  const args = parseV2Args(argLines.filter((l) => l !== ''));
  if (command === 'command=ls-refs') {
    return { status: 200, contentType: UPLOAD_PACK_RESULT, body: lsRefsResponse(repo, args) };
  }
  if (command === 'command=fetch') {
    return { status: 200, contentType: UPLOAD_PACK_RESULT, body: fetchResponse(repo, args) };
  }
  return { status: 400, contentType: 'application/json', body: Buffer.from('{"message":"Bad Request"}\n') };
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function receivePack(repo: Repo, body: Buffer): GitResult {
  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  let sideband = false;
  let commands: PushCommand[] = [];
  let packBytes: Buffer | null = null;
  try {
    const { lines, packOffset } = decodePktLines(body);
    if (lines.length === 0) throw new Error('no commands');
    commands = lines.map((rawLine) => {
      const nul = rawLine.indexOf('\0');
      const line = (nul >= 0 ? rawLine.slice(0, nul) : rawLine).replace(/\n$/, '');
      if (nul >= 0 && rawLine.slice(nul + 1).includes('side-band-64k')) sideband = true;
      const parts = line.split(' ');
      if (parts.length !== 3) throw new Error('bad command line');
      return { oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string };
    });
    packBytes = packOffset < body.length ? body.subarray(packOffset) : null;
  } catch {
    unpackOk = false;
    unpackDetail = 'unpacker error';
  }
  const newObjects = new Map<string, GitObject>();
  if (unpackOk && packBytes && packBytes.length > 0) {
    try {
      const read = readPack(packBytes);
      for (const [oid, obj] of read.objects) newObjects.set(oid, obj);
    } catch {
      unpackOk = false;
      unpackDetail = 'unpacker error';
    }
  }
  if (unpackOk) {
    // Store the unpacked objects even when individual refs are refused.
    for (const [oid, obj] of newObjects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    }
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (!current || current !== command.oldOid) {
          reportLines.push(`ng ${command.ref} invalid old value\n`);
        } else {
          repo.refs.delete(command.ref);
          reportLines.push(`ok ${command.ref}\n`);
        }
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        // Create.
        if (current) {
          reportLines.push(`ng ${command.ref} already exists\n`);
        } else if (!repo.objects.has(command.newOid)) {
          reportLines.push(`ng ${command.ref} new object not held\n`);
        } else {
          repo.refs.set(command.ref, command.newOid);
          reportLines.push(`ok ${command.ref}\n`);
        }
        continue;
      }
      // Update.
      if (!current || current !== command.oldOid) {
        reportLines.push(`ng ${command.ref} invalid old value\n`);
      } else if (!repo.objects.has(command.newOid)) {
        reportLines.push(`ng ${command.ref} new object not held\n`);
      } else if (!isDescendant(repo, command.newOid, command.oldOid)) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      } else {
        repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}\n`);
      }
    }
  }
  const inner = Buffer.concat([
    pktLine(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`),
    ...reportLines.map((l) => pktLine(l)),
  ]);
  let bodyOut: Buffer;
  if (sideband) {
    const chunks: Buffer[] = [];
    const CHUNK = 65515;
    for (let offset = 0; offset < inner.length; offset += CHUNK) {
      const slice = inner.subarray(offset, Math.min(offset + CHUNK, inner.length));
      chunks.push(pktLineRaw(Buffer.concat([Buffer.from([1]), slice])));
    }
    chunks.push(pktFlush());
    bodyOut = Buffer.concat(chunks);
  } else {
    bodyOut = Buffer.concat([inner, pktFlush()]);
  }
  return { status: 200, contentType: RECEIVE_PACK_RESULT, body: bodyOut };
}

/** True when `descendant` is the same commit as, or a descendant of, `ancestor`. */
function isDescendant(repo: Repo, descendant: string, ancestor: string): boolean {
  const target = peelToNonTag(repo.objects, descendant);
  const base = peelToNonTag(repo.objects, ancestor);
  if (target === base) return true;
  const seen = new Set<string>();
  const queue = [target];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const info = parseCommit(obj.data);
    for (const parent of info.parents) {
      if (parent === base) return true;
      queue.push(parent);
    }
  }
  return false;
}

export { hashObject };
