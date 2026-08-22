# agent-agent Development Patterns

> Corrected skill — aligned with actual codebase on 2026-08-22.
> For authoritative rules see `AGENTS.md` (root) and `CLAUDE.md`. This file supplements, never overrides.

## Overview

`agent-agent` is a TypeScript 5.9 + native ESM monorepo (npm workspaces, 14 packages).
Node ≥ 22.18. Backend runs TS directly via `node src/server.ts` — no pre-compilation.
Tests use native `node --test` — **no Jest, no Vitest, no Mocha**.

## Coding Conventions

- **Language:** TypeScript (`.ts`) for all source and test files.
- **Module system:** Native ESM only. All relative imports **must** include `.ts` suffix.
  ```ts
  import { createAgent } from './agentFactory.ts';
  ```
- **Export style:** Prefer **named exports**.
  ```ts
  export function createAgent(): Agent { ... }
  ```
- **File naming:** `kebab-case` for most files (e.g. `feishu-commander-handler.ts`);
  `camelCase` for some service files. Follow the existing convention in the target directory.
- **Commit messages:** [Conventional Commits](https://www.conventionalcommits.org/) — `feat`, `fix`, `docs`, etc.

## Directory Boundaries

| Directory | Purpose | Must NOT contain |
|---|---|---|
| `apps/` | Runnable products, business Agents, on-demand tools | Shared libraries, role definitions |
| `agents/` | Role definition quartet: `manifest.json` + `prompts/system.md` + `岗位卡.md` + `README.md` | Executable business logic |
| `integrations/` | Platform adapters (Feishu / Hermes / Paperclip) | Business logic (must not import platform SDKs directly) |
| `packages/` | Shared modules with **2+ real consumers** only | Single-consumer code |
| `ops/` | Deploy, monitor, recovery, rollback | Business code |

## Testing Patterns

- **Framework:** Native `node --test` (Node.js built-in test runner).
- **File naming:** `*.test.ts` in `test/` directories.
- **Example:**
  ```ts
  import { describe, it } from 'node:test';
  import assert from 'node:assert/strict';
  import { createAgent } from '../src/agent-factory.ts';

  describe('Agent factory', () => {
    it('creates agent with correct manifest', () => {
      const agent = createAgent({ agentId: 'test-agent' });
      assert.equal(agent.agentId, 'test-agent');
    });
  });
  ```
- **Run:** `npm run test:affected` (daily), `npm test` (full), `npm run test:core` (4 core packages).

## Key Commands

| Command | Purpose |
|---|---|
| `npm run check` | Architecture + tsc + frontend build + TS ratio gate |
| `npm run check:architecture` | Shared package dependency direction + directory classification |
| `npm run test:affected` | Change-aware package-level regression (daily driver) |
| `npm run test:core` | Four core runtime packages |
| `npm run runtime:fingerprint` | Live release / PID / cwd / argv / HTTP readback |
| `npm run diagnose:feishu-chain` | Read-only Feishu chain diagnosis (6 checks, zero side-effects) |

## Workflows

### Add New Agent
1. Create `agents/<agentId>/` with `manifest.json` (conforms to `agents/schema/agent-manifest.schema.json`), `prompts/system.md`, `岗位卡.md`, `README.md`.
2. Create runtime integration in `apps/ajun-runtime/src/` (TypeScript, `.ts`).
3. Add tests in `apps/ajun-runtime/test/` (`*.test.ts`).
4. Update `docs/architecture/` and `docs/design/` as needed.

### Update Agent Governance
1. Update governance docs in `docs/handoffs/current/` and `docs/reviews/`.
2. Update acceptance criteria in `docs/reviews/<workflow>/acceptance.md`.
3. Update implementation plan in `docs/plans/` and PRD in `tasks/`.
4. Update runtime logic and tests.

### Integrate External Adapter
1. Add adapter in `integrations/<adapter>/` — business logic must not import platform SDKs.
2. Add tests.
3. Update adapter documentation.

## Critical Rules (from AGENTS.md + CLAUDE.md)

- **Reuse first**: Before building new console/queue/scheduler/budget/approval/audit, check repo → installed CLI → official docs → public implementations.
- **Capability Truth 5 layers**: Declared → Configured → Runtime-reachable → Task-verified → Human-accepted. Never claim a lower layer proves a higher one.
- **No secrets in code/docs/prompts/logs**: `.env` contents, tokens, cookies must never appear anywhere in the repo.
- **Tests must be factual**: Unverified external capabilities must be explicitly marked as unverified.
