# github-core-clone-01

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![Rank](https://make.fun/badge/github-core-clone-01/Calistaa113/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![Reward](https://make.fun/badge/github-core-clone-01/Calistaa113/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A GitHub-compatible forge for the [make.fun bounty](https://make.fun/bounty/github-core-clone-01):
a single Node 22 stdlib-only TypeScript program that speaks Git smart HTTP (v0/v2), REST v3,
GraphQL v4 and MCP over one in-memory store, so the same repository, issue and pull request are
visible through every surface.

## What it implements

- **Git smart HTTP** — v0 and v2 advertisements, v2 `ls-refs` (peel, symrefs, unborn,
  ref-prefix) and `fetch` (want/have, shallow boundaries, deepen, incremental fetches that send
  only the objects the client lacks), and `receive-pack` with fast-forward, create and delete
  rules and `report-status` over sideband 64k. Packs are plain packfile v2 objects, written and
  read with the standard library.
- **REST v3** — repositories, branches, refs, commits, contents (create/update/delete with
  optimistic `sha` checks), labels, issues (shared numbering with pull requests), comments,
  pull requests (diff files, conflict detection, squash merge) and `Link` pagination.
- **GraphQL v4** — a small parser/executor for the fixed documents: variables, aliases, inline
  fragments, `__type` introspection, connections with cursors, and the five mutations
  (`createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest`, `addComment`).
- **MCP** — streamable HTTP with both the modern `server/discover` era and the legacy
  `initialize` era, and the six canonical tools (`create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`).

## Determinism

Everything the server answers is derived from its inputs: the viewer login is derived from the
kit's fixed scenario seed, server-made commits use a monotonic counter as their timestamp, and
ids and numbers are assigned in creation order. Two runs on the same instance leave the same
state export byte-for-byte.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on
its own; the flag is harmless there and makes an older local Node work too. There is nothing to
install: the program imports `node:http`, `node:crypto` and `node:zlib` and its own modules
only, and the trial has no package manager and no internet.
