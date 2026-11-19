// app.ts — the entry's HTTP server: routing, auth, request ids, JSON bodies.
// Lifecycle (register/done) lives in main.ts, which imports only createApp from here.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import {
  createComment,
  createIssue,
  createLabel,
  createPull,
  createRef,
  createUserRepo,
  deleteContents,
  deleteRepo,
  getBranch,
  getCommit,
  getContents,
  getIssue,
  getMeta,
  getPull,
  getRef,
  getRepo,
  getRoot,
  getUser,
  listBranches,
  listComments,
  listCommits,
  listIssues,
  listLabels,
  listPullFiles,
  listPulls,
  listUserRepos,
  mergePull,
  patchIssue,
  patchRepo,
  putContents,
  type Query,
  type RestResult,
} from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { infoRefsReceivePack, infoRefsUploadPack, receivePack, uploadPack } from './git.ts';
import { VIEWER } from './scenario.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

const store = new Store();
let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

function sendRest(res: ServerResponse, result: RestResult): void {
  if (result.status === 204) {
    res.writeHead(204, { 'x-github-request-id': nextRequestId() });
    res.end();
    return;
  }
  const headers: Record<string, string> = {};
  if (result.link) headers.link = result.link;
  sendJson(res, result.status, result.json, headers);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  // Event-based read: cheaper than the async iterator for the small bodies the bench sends.
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseQuery(url: URL): Query {
  const query: Query = {};
  for (const [key, value] of url.searchParams) query[key] = value;
  return query;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length);
  if (presented.length === 0) return false;
  if (TOKEN === '') return true;
  return presented === TOKEN;
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res).catch((err: unknown) => {
      try {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
      } catch {
        // The response may already be gone; nothing more to do.
      }
    });
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const path = url.pathname;
  const origin = `http://${req.headers.host ?? '127.0.0.1'}`;

  // The env's boot probe: 200 {"ok":true}, no auth.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return;
  }

  // API root.
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    sendJson(res, 200, getRoot().json, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (method === 'GET' && path === '/api/v3/meta') {
    sendRest(res, getMeta());
    return;
  }
  if (method === 'GET' && path === '/api/v3/user') {
    sendRest(res, getUser());
    return;
  }
  if (path === '/api/v3/user/repos') {
    const query = parseQuery(url);
    if (method === 'GET') {
      sendRest(res, listUserRepos(store, query, origin));
      return;
    }
    if (method === 'POST') {
      const body = await readJsonBody(req, res);
      if (body === undefined) return;
      sendRest(res, createUserRepo(store, body, origin));
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // GraphQL.
  if (method === 'POST' && path === '/api/graphql') {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const result = handleGraphql(store, body);
    sendJson(res, result.status, result.json);
    return;
  }

  // MCP.
  if (method === 'POST' && path === '/mcp') {
    const body = await readJsonBody(req, res, true);
    if (body === undefined) return;
    const result = handleMcp(store, body, origin);
    if (result.status === 202) {
      res.writeHead(202, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    sendJson(res, result.status, result.json);
    return;
  }

  // Git smart HTTP: /:owner/:repo.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch) {
    const owner = decodeSegment(gitMatch[1] as string);
    const repoName = decodeSegment(gitMatch[2] as string);
    const action = gitMatch[3] as string;
    const repo = owner === VIEWER.login ? store.getRepo(owner, repoName) : undefined;
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (method === 'GET' && action === 'info/refs') {
      const service = url.searchParams.get('service');
      if (service === 'git-upload-pack') {
        const gitProtocol = req.headers['git-protocol'] ?? null;
        const result = infoRefsUploadPack(repo, gitProtocol);
        sendRaw(res, result.status, result.contentType, result.body);
        return;
      }
      if (service === 'git-receive-pack') {
        const result = infoRefsReceivePack(repo);
        sendRaw(res, result.status, result.contentType, result.body);
        return;
      }
      sendJson(res, 400, { message: 'Bad Request' });
      return;
    }
    if (method === 'POST' && action === 'git-upload-pack') {
      const body = await readBody(req);
      const result = uploadPack(repo, body);
      if (result.contentType === 'application/json') sendJson(res, result.status, JSON.parse(result.body.toString('utf8')));
      else sendRaw(res, result.status, result.contentType, result.body);
      return;
    }
    if (method === 'POST' && action === 'git-receive-pack') {
      const body = await readBody(req);
      const result = receivePack(repo, body);
      sendRaw(res, result.status, result.contentType, result.body);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // REST /api/v3/repos/:owner/:repo/...
  if (path.startsWith('/api/v3/repos/')) {
    await handleRepos(req, res, url, method, path, origin);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

/** Read a JSON body; on malformed JSON answer 400 and return undefined. */
async function readJsonBody(req: IncomingMessage, res: ServerResponse, mcp = false): Promise<Record<string, unknown> | unknown[] | undefined> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString('utf8')) as Record<string, unknown> | unknown[];
  } catch {
    if (mcp) {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    } else {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
    }
    return undefined;
  }
}

async function handleRepos(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
  path: string,
  origin: string,
): Promise<void> {
  const rest = path.slice('/api/v3/repos/'.length);
  const segments = rest.split('/').map(decodeSegment);
  const owner = segments[0] ?? '';
  const repoName = segments[1] ?? '';
  const tail = segments.slice(2);
  const query = parseQuery(url);

  if (tail.length === 0) {
    if (method === 'GET') sendRest(res, getRepo(store, owner, repoName, origin));
    else if (method === 'PATCH') {
      const body = await readJsonBody(req, res);
      if (body === undefined) return;
      sendRest(res, patchRepo(store, owner, repoName, body as Record<string, unknown>, origin));
    } else if (method === 'DELETE') sendRest(res, deleteRepo(store, owner, repoName));
    else sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  const head = tail[0] as string;
  if (head === 'branches') {
    if (tail.length === 1 && method === 'GET') sendRest(res, listBranches(store, owner, repoName));
    else if (tail.length === 2 && method === 'GET') sendRest(res, getBranch(store, owner, repoName, tail[1] as string));
    else sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (head === 'git' && tail[1] === 'refs') {
    if (tail.length === 2 && method === 'POST') {
      const body = await readJsonBody(req, res);
      if (body === undefined) return;
      sendRest(res, createRef(store, owner, repoName, body as Record<string, unknown>));
    } else if (tail.length === 4 && tail[2] === 'heads' && method === 'GET') {
      sendRest(res, getRef(store, owner, repoName, `refs/heads/${tail[3] as string}`));
    } else sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (head === 'commits') {
    if (tail.length === 1 && method === 'GET') sendRest(res, listCommits(store, owner, repoName, query));
    else if (tail.length === 2 && method === 'GET') sendRest(res, getCommit(store, owner, repoName, tail[1] as string));
    else sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (head === 'contents') {
    const contentPath = tail.slice(1).join('/');
    if (method === 'PUT') {
      const body = await readJsonBody(req, res);
      if (body === undefined) return;
      sendRest(res, putContents(store, owner, repoName, contentPath, body as Record<string, unknown>));
    } else if (method === 'GET') sendRest(res, getContents(store, owner, repoName, contentPath, query));
    else if (method === 'DELETE') {
      const body = await readJsonBody(req, res);
      if (body === undefined) return;
      sendRest(res, deleteContents(store, owner, repoName, contentPath, body as Record<string, unknown>));
    } else sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (head === 'labels') {
    if (tail.length === 1 && method === 'GET') sendRest(res, listLabels(store, owner, repoName));
    else if (tail.length === 1 && method === 'POST') {
      const body = await readJsonBody(req, res);
      if (body === undefined) return;
      sendRest(res, createLabel(store, owner, repoName, body as Record<string, unknown>));
    } else sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (head === 'issues') {
    if (tail.length === 1 && method === 'GET') sendRest(res, listIssues(store, owner, repoName, query));
    else if (tail.length === 1 && method === 'POST') {
      const body = await readJsonBody(req, res);
      if (body === undefined) return;
      sendRest(res, createIssue(store, owner, repoName, body as Record<string, unknown>));
    } else if (tail.length === 2 && method === 'GET') {
      const n = parseInt(tail[1] as string, 10);
      if (Number.isFinite(n)) sendRest(res, getIssue(store, owner, repoName, n));
      else sendJson(res, 404, { message: 'Not Found' });
    } else if (tail.length === 2 && method === 'PATCH') {
      const n = parseInt(tail[1] as string, 10);
      const body = await readJsonBody(req, res);
      if (body === undefined) return;
      if (Number.isFinite(n)) sendRest(res, patchIssue(store, owner, repoName, n, body as Record<string, unknown>));
      else sendJson(res, 404, { message: 'Not Found' });
    } else if (tail.length === 3 && tail[2] === 'comments' && method === 'GET') {
      const n = parseInt(tail[1] as string, 10);
      if (Number.isFinite(n)) sendRest(res, listComments(store, owner, repoName, n));
      else sendJson(res, 404, { message: 'Not Found' });
    } else if (tail.length === 3 && tail[2] === 'comments' && method === 'POST') {
      const n = parseInt(tail[1] as string, 10);
      const body = await readJsonBody(req, res);
      if (body === undefined) return;
      if (Number.isFinite(n)) sendRest(res, createComment(store, owner, repoName, n, body as Record<string, unknown>));
      else sendJson(res, 404, { message: 'Not Found' });
    } else sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (head === 'pulls') {
    if (tail.length === 1 && method === 'GET') sendRest(res, listPulls(store, owner, repoName, query));
    else if (tail.length === 1 && method === 'POST') {
      const body = await readJsonBody(req, res);
      if (body === undefined) return;
      sendRest(res, createPull(store, owner, repoName, body as Record<string, unknown>));
    } else if (tail.length === 2 && method === 'GET') {
      const n = parseInt(tail[1] as string, 10);
      if (Number.isFinite(n)) sendRest(res, getPull(store, owner, repoName, n));
      else sendJson(res, 404, { message: 'Not Found' });
    } else if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
      const n = parseInt(tail[1] as string, 10);
      if (Number.isFinite(n)) sendRest(res, listPullFiles(store, owner, repoName, n));
      else sendJson(res, 404, { message: 'Not Found' });
    } else if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
      const n = parseInt(tail[1] as string, 10);
      const body = await readJsonBody(req, res);
      if (body === undefined) return;
      if (Number.isFinite(n)) sendRest(res, mergePull(store, owner, repoName, n, body as Record<string, unknown>));
      else sendJson(res, 404, { message: 'Not Found' });
    } else sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  sendJson(res, 404, { message: 'Not Found' });
}
