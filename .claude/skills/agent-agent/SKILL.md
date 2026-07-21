```markdown
# agent-agent Development Patterns

> Auto-generated skill from repository analysis

## Overview

This skill teaches you how to contribute to the `agent-agent` JavaScript codebase, which is focused on agent-based architectures without a specific framework. You'll learn the project's coding conventions, how to add new agents, update governance workflows, and integrate external adapters. The guide also covers testing patterns and provides command shortcuts for common tasks.

## Coding Conventions

- **File Naming:** Use `camelCase` for JavaScript files.
  - Example: `agentProposalService.js`, `localAgent.js`
- **Import Style:** Mixed usage of `require` and `import`.
  - Example:
    ```js
    // CommonJS
    const agentUtils = require('./agentUtils');

    // ES Module
    import { getAgentManifest } from './manifestUtils.js';
    ```
- **Export Style:** Prefer **named exports**.
  - Example:
    ```js
    // Named export
    export function createAgent() { ... }

    // Importing named export
    import { createAgent } from './agentFactory.js';
    ```
- **Commit Messages:** Use [Conventional Commits](https://www.conventionalcommits.org/) with prefixes like `feat`, `fix`, `docs`.
  - Example: `feat: add proposal agent manifest`

## Workflows

### Add New Agent
**Trigger:** When introducing a new agent role or capability  
**Command:** `/add-agent`

1. Create or update the agent directory under `agents/`.
2. Add or update `manifest.json` and `prompts/system.md` for the agent.
3. Add or update `README.md` for the agent.
4. Update or create corresponding runtime integration files in `apps/ajun-runtime/src/` (e.g., `local-<agent>.js`, `agent-proposal-service.js`).
5. Add or update related tests in `apps/ajun-runtime/test/`.
6. Update system documentation in `docs/architecture/`, `docs/design/`, `docs/handoffs/`, etc.
7. Update tasks and plans as needed.

**Example Directory Structure:**
```
agents/
  proposalAgent/
    manifest.json
    prompts/
      system.md
    README.md
apps/ajun-runtime/
  src/
    local-proposalAgent.js
    agent-proposal-service.js
  test/
    proposalAgent.test.js
docs/
  architecture/
    proposalAgent.md
  design/
    proposalAgent-design.md
tasks/
  proposalAgent-task.md
```

### Update Agent Governance or Workflow
**Trigger:** When changing or adding governance processes for agent creation or operation  
**Command:** `/update-governance`

1. Update or add governance workflow documentation in `docs/handoffs/current/` and `docs/reviews/`.
2. Update or add acceptance criteria in `docs/reviews/<workflow>/acceptance.md`.
3. Update or add implementation plan in `docs/plans/`.
4. Update or add PRD in `tasks/`.
5. Update or add related runtime logic in `apps/ajun-runtime/src/`.
6. Update or add related tests in `apps/ajun-runtime/test/`.

**Example:**
```
docs/
  handoffs/
    current/
      agent-creation-handoff.md
  reviews/
    agent-creation/
      acceptance.md
  plans/
    agent-creation-plan.md
tasks/
  agent-creation-prd.md
apps/ajun-runtime/
  src/
    agent-governance.js
  test/
    agent-governance.test.js
```

### Integrate or Update External Adapter
**Trigger:** When connecting to or modifying an external system or service  
**Command:** `/add-adapter`

1. Add or update adapter implementation in `integrations/<adapter>/`.
2. Add or update test files for the adapter.
3. Add or update adapter documentation (`README.md`, profiles, scripts).
4. Update related handoff or review documentation if needed.

**Example:**
```
integrations/
  slackAdapter/
    index.js
    README.md
    test/
      slackAdapter.test.js
    profiles/
      slackProfile.json
    scripts/
      setup.mjs
docs/
  handoffs/
    current/
      slackAdapter-handoff.md
  reviews/
    slackAdapter/
      acceptance.md
```

## Testing Patterns

- **Test Files:** Named with `.test.js` suffix and placed alongside or within `test/` directories.
  - Example: `apps/ajun-runtime/test/proposalAgent.test.js`
- **Framework:** Not explicitly specified; use standard Node.js testing libraries (e.g., Mocha, Jest).
- **Typical Structure:**
    ```js
    // proposalAgent.test.js
    import { createAgent } from '../src/local-proposalAgent.js';

    describe('Proposal Agent', () => {
      it('should initialize with correct manifest', () => {
        const agent = createAgent();
        expect(agent.manifest.name).toBe('Proposal Agent');
      });
    });
    ```

## Commands

| Command           | Purpose                                                        |
|-------------------|----------------------------------------------------------------|
| /add-agent        | Add a new agent, including manifest, prompts, docs, and runtime|
| /update-governance| Update agent governance workflows and documentation            |
| /add-adapter      | Add or update an external integration adapter                  |
```
