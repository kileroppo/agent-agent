---
name: update-agent-governance-or-workflow
description: Workflow command scaffold for update-agent-governance-or-workflow in agent-agent.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /update-agent-governance-or-workflow

Use this workflow when working on **update-agent-governance-or-workflow** in `agent-agent`.

## Goal

Implements or updates agent governance workflows and their documentation, including acceptance criteria and handoff docs.

## Common Files

- `docs/handoffs/current/*-handoff.md`
- `docs/reviews/*/acceptance.md`
- `docs/plans/*.md`
- `tasks/*.md`
- `apps/ajun-runtime/src/*.js`
- `apps/ajun-runtime/test/*.test.js`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Update or add governance workflow documentation in docs/handoffs/current/ and docs/reviews/
- Update or add acceptance criteria in docs/reviews/<workflow>/acceptance.md
- Update or add implementation plan in docs/plans/
- Update or add PRD in tasks/
- Update or add related runtime logic in apps/ajun-runtime/src/

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.