---
name: add-new-agent
description: Workflow command scaffold for add-new-agent in agent-agent.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /add-new-agent

Use this workflow when working on **add-new-agent** in `agent-agent`.

## Goal

Adds a new agent to the system, including manifest, prompts, documentation, and runtime integration.

## Common Files

- `agents/*/manifest.json`
- `agents/*/prompts/system.md`
- `agents/*/README.md`
- `apps/ajun-runtime/src/local-*.js`
- `apps/ajun-runtime/src/agent-proposal-service.js`
- `apps/ajun-runtime/test/*.test.js`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Create or update agent directory under agents/
- Add or update manifest.json and prompts/system.md for the agent
- Add or update README.md for the agent
- Update or create corresponding runtime integration files in apps/ajun-runtime/src/ (e.g., local-<agent>.js, agent-proposal-service.js)
- Add or update related tests in apps/ajun-runtime/test/

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.