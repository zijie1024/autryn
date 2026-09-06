# Autryn Agent Guide

This guide applies to the Autryn repository root and all of its subdirectories. It defines how Coding Agents should reason, work, and operate safely. Treat source code, tests, and configuration as the authority for project facts. Start at the [Wiki index](.wiki/index.md) for architecture, runtime behavior, and engineering knowledge.

Autryn automatically loads `AGENTS.md` from the project root as repository guidance.

## 1. First principles

- Establish the objective, constraints, inputs, outputs, and acceptance evidence before choosing an implementation.
- Begin with the required outcomes and invariants. Decompose the problem into verifiable facts, causal relationships, and necessary conditions instead of inferring conclusions from filenames, surface symptoms, or existing practices.
- Distinguish confirmed facts, reasonable inferences, and unknowns. Use source code, tests, configuration, or observed runtime behavior when they can resolve a question.
- Address root causes. Do not conceal problems by swallowing errors, weakening types, deleting assertions, bypassing approval, or adding special cases.
- Choose the smallest sufficient change that satisfies the objective. Avoid features, abstractions, configuration, and extension points unsupported by requirements or evidence.
- Be able to explain the problem, evidence, trade-offs, risks, and verification behind any significant decision.

## 2. Gathering context

1. Inspect the working tree to identify existing user changes and the boundary of the current task.
2. Use the [Wiki index](.wiki/index.md) to identify the relevant module, Workflow, Interface, or engineering area.
3. Read the relevant Wiki page and use its `sources` field to locate the smallest authoritative scope.
4. Read the target implementation, direct dependencies, corresponding tests, and relevant configuration. Expand further only when call relationships or risk require it.

The README serves users, this Agent guide governs working practices, the Wiki organizes durable knowledge, and Git preserves history. If documentation and implementation disagree, verify current behavior and the intended contract, then correct the obsolete side directly.

## 3. Facts and verification

- Keep static inspection, automated checks, actual execution, and observation of external environments distinct. One kind of evidence cannot substitute for another.
- Never report an unexecuted command, untested platform, or unobserved runtime result as passing.
- Derive project commands from the current `package.json`, scripts, and configuration rather than assuming that a remembered command exists.
- Do not treat `dist/`, `node_modules/`, caches, temporary files, or local runtime state as authoritative source facts.
- Match the scope of verification to the risk of the change. A local check cannot establish a cross-module, cross-platform, or release-level claim.

## 4. Scope and change discipline

- Address only the current task. Preserve existing user changes and avoid incidental refactors, bulk renames, or unrelated formatting.
- Treat answering, reviewing, and diagnosing as read-only by default. Modify files only when the user requests changes or the task explicitly includes implementation.
- A documentation task does not authorize changes to application code, configuration, dependencies, or external systems. An implementation task authorizes only the impact necessary to achieve its objective.
- Before changing anything, identify ownership, dependency direction, Public API, persistence, security, and cross-platform implications.
- Reuse existing domain abstractions. Do not duplicate business logic in the CLI, TUI, tests, or Providers.
- Optimize code for clarity, correctness, and maintainability. Concision does not mean compressed expression. Split or combine functions and files according to single responsibility, cohesion, and independent verifiability.
- Follow the established style of the target file. Use kebab-case for files and directories, PascalCase for types, camelCase for functions and variables, and `import type` for type-only imports.
- Preserve common English terms such as Agent, Runtime, Execution, Provider, Session, Turn, Tool, Skill, Middleware, Delegation, CLI, and TUI.
- Account for Windows, macOS, and Linux in paths, Shell behavior, user Home directories, and binary logic.

## 5. Protected boundaries

The following areas are stable or security-sensitive boundaries. Read the linked Wiki pages, source code, and tests before modifying them:

- Module responsibilities and dependency direction: [System architecture](.wiki/architecture/system.md).
- Agent, Tool, and Delegation: [Agent execution](.wiki/workflows/agent-execution.md), [Tool execution](.wiki/workflows/tool-execution.md), and [Delegation](.wiki/workflows/delegation.md).
- Session and Model behavior: [Session lifecycle](.wiki/workflows/session-lifecycle.md) and [Model selection](.wiki/workflows/model-selection.md).
- Package exports: [Public API](.wiki/interfaces/public-api.md).
- Tool Approval, paths, and sensitive data: [Security and permissions](.wiki/engineering/security-and-permissions.md).

Do not bypass Zod validation, Tool Approval, Session leases, revisions, path safety, or cancellation propagation. Do not expose API Keys, Tokens, user conversations, or other sensitive data. Unless the task explicitly requires it, do not change public types, Commands, Tool wire names, the Session Schema, or persistence semantics.

## 6. Implementation requirements

- Validate inputs at system boundaries. Represent expected failures with the existing structured errors instead of throwing ordinary input errors into the top-level flow.
- Cover success and failure paths for asynchronous behavior, streaming, cancellation, timeouts, concurrency, and resource limits.
- For state-changing Tools, evaluate approval, persistent authorization, path scope, and cancellation behavior.
- When changing a public entry point, inspect source exports, `package.json#exports`, build entries, the Package Export smoke test, and usage examples together.
- When changing Tool presentation, inspect both the ANSI and Ink Renderers and maintain shared summary logic first.
- Do not edit `dist/`, `node_modules/`, caches, or other generated artifacts directly.

Load detailed project relationships from the [Wiki](.wiki/index.md) as needed. Follow the current TypeScript, ESLint, and Prettier configuration together with the conventions in the target file and adjacent tests.

## 7. Testing and verification

- Add a regression test for a Bug fix that demonstrates the root cause has been removed.
- Prioritize tests for public behavior, state transitions, Schemas, paths, persistence, permissions, cancellation, concurrency, and error boundaries.
- Provider tests must not call live external APIs. File-system tests must use isolated temporary directories and clean them up.
- Do not add mechanical tests for risk-free pass-through code, but do not replace automated verification of high-risk behavior with manual judgment.
- Run the most relevant checks first, then complete a quality gate proportionate to the risk before delivery.

The primary quality gate is `bun run check`. When Public APIs or build entries change, also run `bun run build:js` and the Package Export smoke test. For platform-binary changes, build the relevant targets and state which platforms were not covered. See [Testing](.wiki/engineering/testing.md) and [Build and release](.wiki/engineering/build-and-release.md) for the complete strategy.

## 8. Documentation maintenance

- Organize content for its intended audience and the problem it solves. Retain only what readers need to understand, use, or maintain the project.
- Document only facts, relationships, scope, and procedures that are currently valid. When facts change, rewrite the authoritative location directly and let Git preserve history.
- Integrate new knowledge into the existing structure and context while removing obsolete or duplicate material. Do not maintain competing versions through appended notes, revision narratives, or before-and-after comparisons.
- State the conclusion first, then provide only the necessary support. Keep each paragraph centered on one fact and use objective, plain language with stable terminology.
- Describe capabilities, relationships, and required boundaries directly. Explain a limitation through its scope and impact rather than organizing the text around a correction narrative.
- Support every definitive statement with a current authoritative source. Do not present an inference, proposal, or unresolved question as established fact.
- Give each knowledge topic one primary documentation location. Other documents should contain only a necessary summary and link. Put durable knowledge in the Wiki and leave precise, volatile details in source code, tests, configuration, or CLI Help.
- Comments should explain intent, reasons, invariants, and non-obvious constraints. They should not restate code line by line or record the history of a change.
- Keep examples aligned with the current Public API. Do not use real secrets, personal paths, or defaults that cannot be understood across platforms.
- When changing public behavior, module responsibilities, cross-module workflows, persistence semantics, or security boundaries, perform the Refresh and Lint procedures defined in [.wiki/SCHEMA.md](.wiki/SCHEMA.md).

Use [Documentation ownership](.wiki/engineering/documentation-ownership.md) to decide where content belongs. Git owns the timeline; the Wiki does not store Raw material, Logs, Archives, Roadmaps, or task summaries.

## 9. Workflow

### Before starting

1. Define the task and its acceptance criteria.
2. Inspect the working tree and relevant Wiki pages.
3. Read the authoritative sources and form a verifiable plan.

### During implementation

1. Keep changes focused, reversible, and reviewable.
2. Update the necessary types, Schemas, tests, exports, and documentation together.
3. Run the smallest relevant verification after each significant behavior change.

### Before completion

1. Run the quality checks and record the results.
2. Inspect the diff, untracked files, and generated artifacts.
3. Confirm that existing user changes remain intact and documentation matches the current implementation.
4. State any checks not run, residual risks, and decisions that still require the user.

## 10. Authorization and irreversible actions

- Do not publish, push, create Tags, permanently delete Sessions, or perform other irreversible external actions without explicit user authorization.
- Before deleting, overwriting, or moving files, confirm the exact target and recovery path. Stop and ask for confirmation if the scope is unclear.
- Do not use destructive commands to clean the working tree. Never revert, overwrite, or commit user changes without permission.

## 11. Delivery

Keep delivery notes focused on outcomes: what changed, the resulting behavior, verification results, uncovered scope, and remaining risks. Do not report only that the task is complete, and do not present internal tool activity as the outcome.
