// graphql.ts — a small GraphQL parser/executor for the fixed documents the suite sends.
// Implements: variables, aliases, inline enums/objects/lists, null variables, operation names,
// inline fragments (`... on Repository`), `__type` introspection, batching (JSON arrays).
// GraphQL-level failures are HTTP 200 with an `errors` array (never HTTP 400); an unknown
// field's error message names the field: `Cannot query field "X" on type "Y".`

import { Store, parseCommit, treeWalkFiles, type Repo } from './store.ts';
import { VIEWER } from './scenario.ts';
import { createIssue as restCreateIssue, createPull as restCreatePull, squashMerge, diffFiles, conflictingPaths } from './rest.ts';

// ---------------------------------------------------------------- lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '\uFEFF') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$&()[]{}:=@'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const esc = source[i + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === '"' ? '"' : esc === '\\' ? '\\' : esc;
          i += 2;
        } else {
          value += source[i] as string;
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (isNameStart(c)) {
      let j = i + 1;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push(isFloat ? { kind: 'float', value: source.slice(i, j) } : { kind: 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------- AST

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selectionSet: SelectionNode[] | null;
}

export interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | null;
  selectionSet: SelectionNode[];
}

export type SelectionNode = FieldNode | FragmentNode;

export interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, ValueNode | undefined>;
  selectionSet: SelectionNode[];
}

export interface FragmentDefNode {
  kind: 'fragmentDef';
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = lex(source);
  }

  peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  next(): Token {
    const t = this.tokens[this.pos] as Token;
    this.pos += 1;
    return t;
  }

  expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`expected ${value}, got ${JSON.stringify(t)}`);
  }

  expectName(): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`expected name, got ${JSON.stringify(t)}`);
    return t.value;
  }

  parseDocument(): Array<OperationNode | FragmentDefNode> {
    const defs: Array<OperationNode | FragmentDefNode> = [];
    while (this.peek().kind !== 'eof') {
      defs.push(this.parseDefinition());
    }
    return defs;
  }

  parseDefinition(): OperationNode | FragmentDefNode {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '{') {
      return { kind: 'operation', operation: 'query', name: null, variables: {}, selectionSet: this.parseSelectionSet() };
    }
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      const operation = this.next().value as 'query' | 'mutation';
      let name: string | null = null;
      if (this.peek().kind === 'name') name = this.next().value as string;
      const variables: Record<string, ValueNode | undefined> = {};
      if (this.peek().kind === 'punct' && this.peek().value === '(') {
        this.next();
        while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
          this.expectPunct('$');
          const varName = this.expectName();
          this.expectPunct(':');
          this.parseType();
          if (this.peek().kind === 'punct' && this.peek().value === '=') {
            this.next();
            variables[varName] = this.parseValue();
          } else {
            variables[varName] = undefined;
          }
        }
        this.expectPunct(')');
      }
      return { kind: 'operation', operation, name, variables, selectionSet: this.parseSelectionSet() };
    }
    if (t.kind === 'name' && t.value === 'fragment') {
      this.next();
      const name = this.expectName();
      const on = this.expectName();
      if (on !== 'on') throw new Error('expected on');
      const typeCondition = this.expectName();
      return { kind: 'fragmentDef', name, typeCondition, selectionSet: this.parseSelectionSet() };
    }
    throw new Error(`unexpected token ${JSON.stringify(t)}`);
  }

  parseType(): void {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  parseSelection(): SelectionNode {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'fragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        const name = this.next().value as string;
        return { kind: 'fragment', typeCondition: name, selectionSet: [] };
      }
      return { kind: 'fragment', typeCondition: null, selectionSet: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    let selectionSet: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selectionSet = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selectionSet };
  }

  parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (t.kind === 'int') return { kind: 'int', value: parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'float', value: parseFloat(t.value) };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
        values.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${JSON.stringify(t)}`);
  }
}

// ---------------------------------------------------------------- values

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': {
      const v = variables[node.name];
      return v === undefined ? null : v;
    }
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

function argMap(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------- global ids

export function globalId(kind: string, rest: string): string {
  return Buffer.from(`${kind}:${rest}`).toString('base64');
}

function decodeGlobalId(id: string): { kind: string; rest: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), rest: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function repoGlobalId(repo: Repo): string {
  return globalId('Repository', `${repo.owner}/${repo.name}`);
}

function issueGlobalId(repo: Repo, number: number): string {
  return globalId('Issue', `${repo.owner}/${repo.name}:${number}`);
}

function pullGlobalId(repo: Repo, number: number): string {
  return globalId('PullRequest', `${repo.owner}/${repo.name}:${number}`);
}

function commentGlobalId(repo: Repo, issueNumber: number, commentId: number): string {
  return globalId('Comment', `${repo.owner}/${repo.name}:${issueNumber}:${commentId}`);
}

function repoFromGlobalId(store: Store, id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Repository') return null;
  const slash = decoded.rest.indexOf('/');
  if (slash < 0) return null;
  const owner = decoded.rest.slice(0, slash);
  const name = decoded.rest.slice(slash + 1);
  if (owner !== VIEWER.login) return null;
  return store.getRepo(owner, name) ?? null;
}

function issueFromGlobalId(store: Store, id: string): { repo: Repo; number: number } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Issue') return null;
  const lastColon = decoded.rest.lastIndexOf(':');
  if (lastColon < 0) return null;
  const repoPart = decoded.rest.slice(0, lastColon);
  const number = parseInt(decoded.rest.slice(lastColon + 1), 10);
  const slash = repoPart.indexOf('/');
  if (slash < 0 || !Number.isFinite(number)) return null;
  const repo = store.getRepo(repoPart.slice(0, slash), repoPart.slice(slash + 1));
  if (!repo) return null;
  return { repo, number };
}

function pullFromGlobalId(store: Store, id: string): { repo: Repo; number: number } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'PullRequest') return null;
  const lastColon = decoded.rest.lastIndexOf(':');
  if (lastColon < 0) return null;
  const repoPart = decoded.rest.slice(0, lastColon);
  const number = parseInt(decoded.rest.slice(lastColon + 1), 10);
  const slash = repoPart.indexOf('/');
  if (slash < 0 || !Number.isFinite(number)) return null;
  const repo = store.getRepo(repoPart.slice(0, slash), repoPart.slice(slash + 1));
  if (!repo) return null;
  return { repo, number };
}

// ---------------------------------------------------------------- schema

const FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Viewer: ['login', 'id', 'name', 'email', '__typename'],
  User: ['login', 'id', 'name', 'email', '__typename'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests',
    'pullRequest', 'description', 'isPrivate', '__typename',
  ],
  Ref: ['name', '__typename'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'url', '__typename'],
  IssueConnection: ['nodes', 'pageInfo', 'edges', 'totalCount', '__typename'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor', '__typename'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName',
    'mergeable', 'files', 'headRef', 'baseRef', 'author', '__typename',
  ],
  PullRequestConnection: ['nodes', 'pageInfo', 'edges', 'totalCount', '__typename'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', '__typename'],
  PullRequestChangedFile: ['path', '__typename'],
  __Type: ['name', 'fields', 'enumValues', '__typename'],
  __Field: ['name', 'description', '__typename'],
  __EnumValue: ['name', 'description', '__typename'],
  CreateIssuePayload: ['issue', '__typename'],
  CloseIssuePayload: ['issue', '__typename'],
  CreatePullRequestPayload: ['pullRequest', '__typename'],
  MergePullRequestPayload: ['pullRequest', '__typename'],
  AddCommentPayload: ['commentEdge', '__typename'],
  IssueCommentEdge: ['node', '__typename'],
  IssueComment: ['id', 'body', '__typename'],
};

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'author', 'comments', 'createdAt', 'url'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName',
    'mergeable', 'files', 'headRef', 'baseRef', 'author',
  ],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests',
    'pullRequest', 'description', 'isPrivate',
  ],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'WIKI', 'MILESTONE', 'PROJECT', 'ORGANIZATION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
};

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string; path?: string[] }>;
  fragments: Map<string, FragmentDefNode>;
}

// ---------------------------------------------------------------- execution

type GqlValue = Record<string, unknown> | unknown[] | string | number | boolean | null;

function executeSelections(
  ctx: Ctx,
  selections: SelectionNode[],
  typeName: string,
  source: unknown,
  path: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition && sel.typeCondition !== typeName && !ctx.fragments.has(sel.typeCondition)) {
        // Inline fragment on another type: skip unless it names a fragment definition.
        continue;
      }
      if (sel.typeCondition && ctx.fragments.has(sel.typeCondition)) {
        const def = ctx.fragments.get(sel.typeCondition) as FragmentDefNode;
        if (def.typeCondition !== typeName) continue;
        Object.assign(out, executeSelections(ctx, def.selectionSet, typeName, source, path));
        continue;
      }
      Object.assign(out, executeSelections(ctx, sel.selectionSet, typeName, source, path));
      continue;
    }
    const field = sel;
    const responseKey = field.alias ?? field.name;
    const fieldPath = [...path, responseKey];
    if (field.name === '__typename') {
      out[responseKey] = typeName;
      continue;
    }
    const allowed = FIELDS[typeName];
    if (!allowed || !allowed.includes(field.name)) {
      ctx.errors.push({
        message: `Cannot query field "${field.name}" on type "${typeName}".`,
        path: fieldPath,
      });
      out[responseKey] = null;
      continue;
    }
    const value = resolveField(ctx, typeName, source, field, fieldPath);
    if (field.selectionSet && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const childType = childTypeName(typeName, field.name, value);
      out[responseKey] = executeSelections(ctx, field.selectionSet, childType, value, fieldPath);
    } else if (field.selectionSet && Array.isArray(value)) {
      const childType = childTypeName(typeName, field.name, null);
      out[responseKey] = value.map((item) =>
        item !== null && typeof item === 'object'
          ? executeSelections(ctx, field.selectionSet as SelectionNode[], childType, item, fieldPath)
          : item,
      );
    } else {
      out[responseKey] = value;
    }
  }
  return out;
}

function childTypeName(parentType: string, fieldName: string, value: unknown): string {
  const map: Record<string, Record<string, string>> = {
    Query: { viewer: 'Viewer', repository: 'Repository', node: 'Repository', __type: '__Type' },
    Mutation: {
      createIssue: 'CreateIssuePayload',
      closeIssue: 'CloseIssuePayload',
      createPullRequest: 'CreatePullRequestPayload',
      mergePullRequest: 'MergePullRequestPayload',
      addComment: 'AddCommentPayload',
    },
    Repository: {
      owner: 'User',
      defaultBranchRef: 'Ref',
      issue: 'Issue',
      issues: 'IssueConnection',
      pullRequests: 'PullRequestConnection',
      pullRequest: 'PullRequest',
    },
    Issue: { author: 'User' },
    PullRequest: { files: 'PullRequestChangedFileConnection', headRef: 'Ref', baseRef: 'Ref', author: 'User' },
    IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo' },
    PullRequestConnection: { nodes: 'PullRequest', pageInfo: 'PageInfo' },
    PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', pageInfo: 'PageInfo' },
    CreateIssuePayload: { issue: 'Issue' },
    CloseIssuePayload: { issue: 'Issue' },
    CreatePullRequestPayload: { pullRequest: 'PullRequest' },
    MergePullRequestPayload: { pullRequest: 'PullRequest' },
    AddCommentPayload: { commentEdge: 'IssueCommentEdge' },
    IssueCommentEdge: { node: 'IssueComment' },
    __Type: { fields: '__Field', enumValues: '__EnumValue' },
  };
  const child = map[parentType]?.[fieldName];
  if (child) return child;
  // Payload wrappers hold the named object directly.
  if (parentType === 'CreateIssuePayload' || parentType === 'CloseIssuePayload') return 'Issue';
  if (parentType === 'CreatePullRequestPayload' || parentType === 'MergePullRequestPayload') return 'PullRequest';
  if (parentType === 'IssueCommentEdge') return 'IssueComment';
  void value;
  return 'Unknown';
}

function resolveField(ctx: Ctx, typeName: string, source: unknown, field: FieldNode, path: string[]): GqlValue {
  const args = argMap(field, ctx.variables);
  const store = ctx.store;
  const src = source as Record<string, unknown> & { __kind?: string };

  if (typeName === 'Query') {
    if (field.name === 'viewer') {
      return { __kind: 'Viewer', login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email };
    }
    if (field.name === 'repository') {
      const owner = args.owner as string;
      const name = args.name as string;
      if (owner !== VIEWER.login) return null;
      const repo = store.getRepo(owner, name);
      return repo ? wrapRepo(repo) : null;
    }
    if (field.name === 'node') {
      const repo = repoFromGlobalId(store, String(args.id ?? ''));
      return repo ? wrapRepo(repo) : null;
    }
    if (field.name === '__type') {
      const name = args.name as string;
      return { __kind: '__Type', name };
    }
  }

  if (typeName === 'Mutation') {
    return resolveMutation(ctx, field, args, path);
  }

  if (typeName === 'Viewer' || typeName === 'User') {
    if (field.name === 'login') return (src.login as string) ?? VIEWER.login;
    if (field.name === 'id') return (src.id as number) ?? VIEWER.id;
    if (field.name === 'name') return (src.name as string) ?? VIEWER.name;
    if (field.name === 'email') return (src.email as string) ?? VIEWER.email;
  }

  if (typeName === '__Type') {
    const name = (src.name as string) ?? '';
    if (field.name === 'name') return name;
    if (field.name === 'fields') {
      return (TYPE_FIELDS[name] ?? []).map((f) => ({ __kind: '__Field', name: f }));
    }
    if (field.name === 'enumValues') {
      return (TYPE_ENUM_VALUES[name] ?? []).map((v) => ({ __kind: '__EnumValue', name: v }));
    }
  }

  if (typeName === '__Field' || typeName === '__EnumValue') {
    if (field.name === 'name') return src.name as string;
    if (field.name === 'description') return null;
  }

  if (typeName === 'Repository') {
    const repo = (src.__repo as Repo) ?? null;
    if (!repo) return null;
    return resolveRepoField(ctx, repo, field, args);
  }

  if (typeName === 'Issue') {
    const issue = src.__issue as { number: number; title: string; body: string; state: string } | undefined;
    const repo = src.__repo as Repo | undefined;
    if (!issue || !repo) return null;
    if (field.name === 'id') return issueGlobalId(repo, issue.number);
    if (field.name === 'number') return issue.number;
    if (field.name === 'title') return issue.title;
    if (field.name === 'body') return issue.body;
    if (field.name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
    if (field.name === 'author') return { __kind: 'User', login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email };
    if (field.name === 'createdAt') return '2026-01-01T00:00:00Z';
    if (field.name === 'url') return `/${repo.owner}/${repo.name}/issues/${issue.number}`;
  }

  if (typeName === 'PullRequest') {
    const pr = src.__pr as { number: number; title: string; body: string; state: string; merged: boolean; headRef: string; baseRef: string } | undefined;
    const repo = src.__repo as Repo | undefined;
    if (!pr || !repo) return null;
    if (field.name === 'id') return pullGlobalId(repo, pr.number);
    if (field.name === 'number') return pr.number;
    if (field.name === 'title') return pr.title;
    if (field.name === 'body') return pr.body;
    if (field.name === 'state') return pr.state === 'open' ? 'OPEN' : 'CLOSED';
    if (field.name === 'merged') return pr.merged;
    if (field.name === 'headRefName') return pr.headRef;
    if (field.name === 'baseRefName') return pr.baseRef;
    if (field.name === 'mergeable') {
      const full = repo.pulls.get(pr.number);
      if (!full) return 'UNKNOWN';
      return conflictingPaths(repo, full).length === 0 ? 'MERGEABLE' : 'CONFLICTING';
    }
    if (field.name === 'headRef') return { __kind: 'Ref', name: pr.headRef };
    if (field.name === 'baseRef') return { __kind: 'Ref', name: pr.baseRef };
    if (field.name === 'author') return { __kind: 'User', login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email };
    if (field.name === 'files') {
      const full = repo.pulls.get(pr.number);
      if (!full) return { __kind: 'PullRequestChangedFileConnection', nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
      const baseObj = repo.objects.get(full.baseSha);
      const headTip = repo.refs.get(`refs/heads/${full.headRef}`);
      if (!baseObj || !headTip) return { __kind: 'PullRequestChangedFileConnection', nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
      const baseTree = parseCommit(baseObj.data).tree;
      const headTree = parseCommit((repo.objects.get(headTip) as { data: Buffer }).data).tree;
      const files = diffFiles(repo, baseTree, headTree);
      const first = typeof args.first === 'number' ? args.first : files.length;
      return {
        __kind: 'PullRequestChangedFileConnection',
        nodes: files.slice(0, first).map((f) => ({ __kind: 'PullRequestChangedFile', path: f.filename })),
        pageInfo: { hasNextPage: files.length > first, endCursor: null },
      };
    }
  }

  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestChangedFileConnection') {
    if (field.name === 'nodes') return (src.nodes as unknown[]) ?? [];
    if (field.name === 'pageInfo') return (src.pageInfo as Record<string, unknown>) ?? { hasNextPage: false, endCursor: null };
    if (field.name === 'totalCount') return ((src.nodes as unknown[]) ?? []).length;
    if (field.name === 'edges') return ((src.nodes as unknown[]) ?? []).map((n) => ({ node: n, cursor: null }));
  }

  if (typeName === 'PageInfo') {
    if (field.name === 'hasNextPage') return src.hasNextPage ?? false;
    if (field.name === 'endCursor') return src.endCursor ?? null;
    if (field.name === 'hasPreviousPage') return false;
    if (field.name === 'startCursor') return null;
  }

  if (typeName === 'Ref') {
    if (field.name === 'name') return src.name as string;
  }

  if (typeName === 'PullRequestChangedFile') {
    if (field.name === 'path') return src.path as string;
  }

  if (typeName === 'IssueComment') {
    if (field.name === 'id') return src.id as string;
    if (field.name === 'body') return src.body as string;
  }

  if (typeName === 'IssueCommentEdge') {
    if (field.name === 'node') return src.node as Record<string, unknown>;
  }

  if (typeName === 'CreateIssuePayload' || typeName === 'CloseIssuePayload') {
    if (field.name === 'issue') return src.issue as Record<string, unknown>;
  }
  if (typeName === 'CreatePullRequestPayload' || typeName === 'MergePullRequestPayload') {
    if (field.name === 'pullRequest') return src.pullRequest as Record<string, unknown>;
  }
  if (typeName === 'AddCommentPayload') {
    if (field.name === 'commentEdge') return src.commentEdge as Record<string, unknown>;
  }

  return null;
}

function wrapRepo(repo: Repo): Record<string, unknown> {
  return { __kind: 'Repository', __repo: repo };
}

function wrapIssue(repo: Repo, issue: { number: number; title: string; body: string; state: string }): Record<string, unknown> {
  return { __kind: 'Issue', __repo: repo, __issue: issue };
}

function wrapPull(repo: Repo, pr: { number: number; title: string; body: string; state: string; merged: boolean; headRef: string; baseRef: string }): Record<string, unknown> {
  return { __kind: 'PullRequest', __repo: repo, __pr: pr };
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`).toString('base64');
}

function cursorToNumber(cursor: string | null | undefined): number | null {
  if (!cursor) return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = parseInt(text.slice(7), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function resolveRepoField(ctx: Ctx, repo: Repo, field: FieldNode, args: Record<string, unknown>): GqlValue {
  switch (field.name) {
    case 'id':
      return repoGlobalId(repo);
    case 'databaseId':
      return repo.id;
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return `${repo.owner}/${repo.name}`;
    case 'owner':
      return { __kind: 'User', login: repo.owner, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email };
    case 'defaultBranchRef': {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      return tip ? { __kind: 'Ref', name: repo.defaultBranch } : null;
    }
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
      return true;
    case 'description':
      return repo.description;
    case 'isPrivate':
      return repo.privateFlag;
    case 'issue': {
      const number = args.number as number;
      const issue = repo.issues.get(number);
      return issue ? wrapIssue(repo, issue) : null;
    }
    case 'issues': {
      let issues = [...repo.issues.values()];
      const states = args.states as string[] | undefined;
      if (states && states.length > 0) {
        const wanted = new Set(states.map((s) => (s === 'OPEN' ? 'open' : 'closed')));
        issues = issues.filter((i) => wanted.has(i.state));
      }
      const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
      const direction = orderBy?.direction ?? 'ASC';
      issues.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
      const after = cursorToNumber(args.after as string | null | undefined);
      if (after !== null) issues = issues.filter((i) => (direction === 'DESC' ? i.number < after : i.number > after));
      const first = typeof args.first === 'number' ? args.first : issues.length;
      const page = issues.slice(0, first);
      const hasNextPage = issues.length > first;
      const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]?.number as number) : null;
      return {
        __kind: 'IssueConnection',
        nodes: page.map((i) => wrapIssue(repo, i)),
        pageInfo: { hasNextPage, endCursor },
      };
    }
    case 'pullRequests': {
      let pulls = [...repo.pulls.values()].filter((p) => p.state === 'open');
      pulls.sort((a, b) => b.number - a.number);
      const first = typeof args.first === 'number' ? args.first : pulls.length;
      const page = pulls.slice(0, first);
      return {
        __kind: 'PullRequestConnection',
        nodes: page.map((p) => wrapPull(repo, p)),
        pageInfo: { hasNextPage: pulls.length > first, endCursor: null },
      };
    }
    case 'pullRequest': {
      const number = args.number as number;
      const pr = repo.pulls.get(number);
      return pr ? wrapPull(repo, pr) : null;
    }
    default:
      return null;
  }
}

function resolveMutation(ctx: Ctx, field: FieldNode, args: Record<string, unknown>, path: string[]): GqlValue {
  const store = ctx.store;
  const input = (args.input ?? {}) as Record<string, unknown>;
  if (field.name === 'createIssue') {
    const repo = repoFromGlobalId(store, String(input.repositoryId ?? ''));
    if (!repo) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the global id.', path });
      return { __kind: 'CreateIssuePayload', issue: null };
    }
    const result = restCreateIssue(store, repo.owner, repo.name, {
      title: String(input.title ?? ''),
      body: typeof input.body === 'string' ? input.body : '',
    });
    if (result.status !== 201) {
      ctx.errors.push({ message: String((result.json as Record<string, unknown>).message ?? 'createIssue failed'), path });
      return { __kind: 'CreateIssuePayload', issue: null };
    }
    const created = result.json as { number: number };
    const issue = repo.issues.get(created.number);
    return { __kind: 'CreateIssuePayload', issue: issue ? wrapIssue(repo, issue) : null };
  }
  if (field.name === 'closeIssue') {
    const found = issueFromGlobalId(store, String(input.issueId ?? ''));
    if (!found) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the global id.', path });
      return { __kind: 'CloseIssuePayload', issue: null };
    }
    const issue = found.repo.issues.get(found.number);
    if (!issue) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the global id.', path });
      return { __kind: 'CloseIssuePayload', issue: null };
    }
    issue.state = 'closed';
    return { __kind: 'CloseIssuePayload', issue: wrapIssue(found.repo, issue) };
  }
  if (field.name === 'createPullRequest') {
    const repo = repoFromGlobalId(store, String(input.repositoryId ?? ''));
    if (!repo) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the global id.', path });
      return { __kind: 'CreatePullRequestPayload', pullRequest: null };
    }
    const result = restCreatePull(store, repo.owner, repo.name, {
      title: String(input.title ?? ''),
      head: String(input.headRefName ?? ''),
      base: String(input.baseRefName ?? ''),
    });
    if (result.status !== 201) {
      // A duplicate open PR is tolerated by the fixture path: return the existing one.
      const existing = [...repo.pulls.values()].find(
        (p) => p.state === 'open' && p.headRef === String(input.headRefName ?? '') && p.baseRef === String(input.baseRefName ?? ''),
      );
      if (existing) return { __kind: 'CreatePullRequestPayload', pullRequest: wrapPull(repo, existing) };
      ctx.errors.push({ message: String((result.json as Record<string, unknown>).message ?? 'createPullRequest failed'), path });
      return { __kind: 'CreatePullRequestPayload', pullRequest: null };
    }
    const created = result.json as { number: number };
    const pr = repo.pulls.get(created.number);
    return { __kind: 'CreatePullRequestPayload', pullRequest: pr ? wrapPull(repo, pr) : null };
  }
  if (field.name === 'mergePullRequest') {
    const found = pullFromGlobalId(store, String(input.pullRequestId ?? ''));
    if (!found) {
      ctx.errors.push({ message: 'Could not resolve to a PullRequest with the global id.', path });
      return { __kind: 'MergePullRequestPayload', pullRequest: null };
    }
    const pr = found.repo.pulls.get(found.number);
    if (!pr) {
      ctx.errors.push({ message: 'Could not resolve to a PullRequest with the global id.', path });
      return { __kind: 'MergePullRequestPayload', pullRequest: null };
    }
    const result = squashMerge(store, found.repo, pr);
    if (!result.ok) {
      ctx.errors.push({ message: 'Pull request cannot be merged', path });
      return { __kind: 'MergePullRequestPayload', pullRequest: wrapPull(found.repo, pr) };
    }
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = '2026-01-01T00:00:00Z';
    pr.mergeCommitSha = result.sha ?? null;
    return { __kind: 'MergePullRequestPayload', pullRequest: wrapPull(found.repo, pr) };
  }
  if (field.name === 'addComment') {
    const found = issueFromGlobalId(store, String(input.subjectId ?? ''));
    if (!found) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the global id.', path });
      return { __kind: 'AddCommentPayload', commentEdge: null };
    }
    const issue = found.repo.issues.get(found.number);
    if (!issue) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the global id.', path });
      return { __kind: 'AddCommentPayload', commentEdge: null };
    }
    const body = String(input.body ?? '');
    const comment = { id: found.repo.nextCommentId, body, userLogin: VIEWER.login };
    found.repo.nextCommentId += 1;
    issue.comments.push(comment);
    return {
      __kind: 'AddCommentPayload',
      commentEdge: {
        __kind: 'IssueCommentEdge',
        node: {
          __kind: 'IssueComment',
          id: commentGlobalId(found.repo, found.number, comment.id),
          body: comment.body,
        },
      },
    };
  }
  return null;
}

// ---------------------------------------------------------------- entry point

export interface GraphqlResult {
  status: number;
  json: unknown;
}

function executeOperation(store: Store, op: OperationNode, variables: Record<string, unknown>, fragments: Map<string, FragmentDefNode>): Record<string, unknown> {
  const ctx: Ctx = { store, variables, errors: [], fragments };
  const rootType = op.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(ctx, op.selectionSet, rootType, null, []);
  const out: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) out.errors = ctx.errors;
  return out;
}

export function handleGraphql(store: Store, body: unknown): GraphqlResult {
  const isBatch = Array.isArray(body);
  const requests = isBatch ? (body as unknown[]) : [body];
  const results: Record<string, unknown>[] = [];
  for (const request of requests) {
    const record = request as Record<string, unknown> | null;
    if (!record || typeof record.query !== 'string') {
      results.push({ data: null, errors: [{ message: 'A query is required.' }] });
      continue;
    }
    const variables = (record.variables ?? {}) as Record<string, unknown>;
    const operationName = typeof record.operationName === 'string' ? record.operationName : null;
    let defs: Array<OperationNode | FragmentDefNode>;
    try {
      defs = new Parser(record.query).parseDocument();
    } catch (err) {
      results.push({ data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] });
      continue;
    }
    const fragments = new Map<string, FragmentDefNode>();
    const operations: OperationNode[] = [];
    for (const def of defs) {
      if (def.kind === 'fragmentDef') fragments.set(def.name, def);
      else operations.push(def);
    }
    const op = operationName
      ? operations.find((o) => o.name === operationName) ?? operations[0]
      : operations[0];
    if (!op) {
      results.push({ data: null, errors: [{ message: 'No operation provided.' }] });
      continue;
    }
    const mergedVariables: Record<string, unknown> = {};
    for (const [name, defaultNode] of Object.entries(op.variables)) {
      if (variables[name] !== undefined) mergedVariables[name] = variables[name];
      else if (defaultNode) mergedVariables[name] = resolveValue(defaultNode, variables);
      else mergedVariables[name] = null;
    }
    for (const [name, value] of Object.entries(variables)) {
      if (!(name in mergedVariables)) mergedVariables[name] = value;
    }
    results.push(executeOperation(store, op, mergedVariables, fragments));
  }
  return { status: 200, json: isBatch ? results : results[0] };
}
