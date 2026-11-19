// mcp.ts — MCP streamable HTTP endpoint (plain JSON responses; no SSE needed).
// Both eras: modern `server/discover` and legacy `initialize` + `notifications/initialized`.
// The six canonical tools mutate the same store REST/GraphQL read.

import { Store } from './store.ts';
import {
  createIssue,
  createPull,
  createUserRepo,
  getRepo,
  listIssues,
  mergePull,
} from './rest.ts';

const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';

export const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
}

// Static and byte-identical across calls (the tools/list check requires it).
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
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
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
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
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'integer', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

export interface McpResult {
  status: number;
  json: unknown;
}

interface ToolCallOutcome {
  structured: Record<string, unknown>;
  isError: boolean;
}

function splitOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((!owner || !repo) && typeof args.full_name === 'string') {
    const slash = args.full_name.indexOf('/');
    if (slash > 0) {
      owner = args.full_name.slice(0, slash);
      repo = args.full_name.slice(slash + 1);
    }
  }
  return { owner, repo };
}

function missingArg(args: Record<string, unknown>, required: string[]): string | null {
  for (const key of required) {
    const value = args[key];
    if (value === undefined || value === null || value === '') return key;
  }
  return null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>, origin: string): ToolCallOutcome {
  const requiredFor: Record<string, string[]> = {
    create_repo: ['name'],
    get_repo: ['owner', 'repo'],
    create_issue: ['owner', 'repo', 'title'],
    list_issues: ['owner', 'repo'],
    create_pull_request: ['owner', 'repo', 'title', 'head', 'base'],
    merge_pull_request: ['owner', 'repo', 'pull_number'],
  };
  const required = requiredFor[name];
  if (!required) {
    return { structured: { error: `unknown tool ${name}` }, isError: true };
  }
  const missing = missingArg(args, required);
  if (missing) {
    return { structured: { error: `missing required argument: ${missing}` }, isError: true };
  }
  const { owner, repo } = splitOwnerRepo(args);
  switch (name) {
    case 'create_repo': {
      const result = createUserRepo(store, args, origin);
      if (result.status !== 201) {
        return { structured: { error: String((result.json as Record<string, unknown>).message ?? 'create_repo failed') }, isError: true };
      }
      const view = result.json as Record<string, unknown>;
      return {
        structured: {
          id: view.id,
          name: view.name,
          full_name: view.full_name,
          private: view.private,
          default_branch: view.default_branch,
          description: view.description,
        },
        isError: false,
      };
    }
    case 'get_repo': {
      const result = getRepo(store, owner, repo, origin);
      if (result.status !== 200) {
        return { structured: { error: `repository ${owner}/${repo} not found` }, isError: true };
      }
      return { structured: result.json as Record<string, unknown>, isError: false };
    }
    case 'create_issue': {
      const result = createIssue(store, owner, repo, args);
      if (result.status !== 201) {
        return { structured: { error: String((result.json as Record<string, unknown>).message ?? 'create_issue failed') }, isError: true };
      }
      const view = result.json as Record<string, unknown>;
      return {
        structured: {
          id: view.id,
          number: view.number,
          title: view.title,
          body: view.body,
          state: view.state,
          labels: view.labels,
        },
        isError: false,
      };
    }
    case 'list_issues': {
      const result = listIssues(store, owner, repo, { state: typeof args.state === 'string' ? args.state : 'open' });
      if (result.status !== 200) {
        return { structured: { error: `repository ${owner}/${repo} not found` }, isError: true };
      }
      const issues = result.json as Record<string, unknown>[];
      return {
        structured: {
          issues: issues.map((i) => ({ id: i.id, number: i.number, title: i.title, body: i.body, state: i.state })),
        },
        isError: false,
      };
    }
    case 'create_pull_request': {
      const result = createPull(store, owner, repo, args);
      if (result.status !== 201) {
        return { structured: { error: String((result.json as Record<string, unknown>).message ?? 'create_pull_request failed') }, isError: true };
      }
      const view = result.json as Record<string, unknown>;
      return {
        structured: {
          id: view.id,
          number: view.number,
          title: view.title,
          body: view.body,
          state: view.state,
          head: view.head,
          base: view.base,
        },
        isError: false,
      };
    }
    case 'merge_pull_request': {
      const pullNumber = typeof args.pull_number === 'number' ? args.pull_number : parseInt(String(args.pull_number), 10);
      const result = mergePull(store, owner, repo, pullNumber, { merge_method: 'squash' });
      if (result.status !== 200) {
        return { structured: { error: String((result.json as Record<string, unknown>).message ?? 'merge_pull_request failed') }, isError: true };
      }
      const merged = result.json as Record<string, unknown>;
      return {
        structured: { merged: true, sha: merged.sha, number: pullNumber, message: merged.message },
        isError: false,
      };
    }
    default:
      return { structured: { error: `unknown tool ${name}` }, isError: true };
  }
}

export function handleMcp(store: Store, body: unknown, origin: string): McpResult {
  const record = body as Record<string, unknown> | null;
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const id = record.id === undefined ? null : record.id;
  const method = typeof record.method === 'string' ? record.method : '';
  const params = (record.params ?? {}) as Record<string, unknown>;

  // Notifications carry no id: 202 with an empty body.
  if (id === null || id === undefined) {
    return { status: 202, json: null };
  }

  const result = (value: unknown): McpResult => ({ status: 200, json: { jsonrpc: '2.0', id, result: value } });
  const error = (code: number, message: string): McpResult => ({
    status: 200,
    json: { jsonrpc: '2.0', id, error: { code, message } },
  });

  if (method === 'server/discover') {
    return result({
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    return result({
      protocolVersion: offered,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'tools/list') {
    return result({ tools: TOOLS });
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      return error(-32602, `unknown tool ${name}`);
    }
    const outcome = callTool(store, name, args, origin);
    return result({
      content: [{ type: 'text', text: JSON.stringify(outcome.structured) }],
      structuredContent: outcome.structured,
      isError: outcome.isError,
    });
  }
  return error(-32601, `Method not found: ${method}`);
}
