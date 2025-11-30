# Repository Guidelines

## Project Structure & Module Organization
- `api/mcp.ts`: Vercel serverless entrypoint implementing the MCP endpoint.
- `lib/agent/`: Agent loop and orchestration (`execute.ts`, `describe.ts`, `progress.ts`, `config.ts`, `validation.ts`).
- `lib/agent/actions/`: Action handler registry; add new actions by wiring handlers into `handlers.ts` and exporting through `index.ts`.
- `lib/cua-client.ts`: Thin CUA Cloud API client used by the agent.
- `lib/tool-schemas.ts`: MCP tool definitions and shared schemas.

## Build, Test, and Development Commands
- Install deps: `npm ci` (preferred for lockfile fidelity) or `npm install`.
- Run locally: `npm run dev` (wrapper around `vercel dev`)—requires Vercel CLI and the env vars below.
- Type-check: `npx tsc --noEmit` to catch regressions before submitting.
- Deploy (maintainers): `vercel --prod` after verifying locally.

## Coding Style & Naming Conventions
- Language: TypeScript ES2022, ESM imports with explicit `.js` extensions inside the repo.
- Indent 2 spaces; keep lines purposeful and comments brief, explaining non-obvious logic only.
- Exports: favor named exports; group related constants/types near usage.
- Naming: camelCase for variables/functions, SCREAMING_SNAKE_CASE for constants, lower_snake_case for action names and wire protocol fields to match MCP/agent schemas.
- Files: keep existing pattern (`kebab-case` or descriptive names) under `lib/` and `api/`.

## Testing Guidelines
- No automated test suite yet; rely on type checks plus manual calls.
- Quick manual check: start dev server, then `curl -X POST http://localhost:3000/mcp -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_sandboxes","arguments":{}}}'` to confirm request flow.
- Add targeted tests when introducing new behaviors; keep fixtures minimal and schema-accurate.

## Commit & Pull Request Guidelines
- Commits: short, imperative summaries (e.g., "Add triple_click action", "Remove unused release_key handler").
- Scope: one logical change per commit; include reasoning in the PR description rather than the commit body.
- PRs should include: summary of change, manual verification steps/commands run, affected endpoints/tools, and any screenshots or sample responses when behavior changes.
- Link issues or TODOs where applicable; call out breaking changes or new env requirements explicitly.

## Security & Configuration Tips
- Required env: `CUA_API_KEY`, `ANTHROPIC_API_KEY`, `BLOB_READ_WRITE_TOKEN`; optional: `CUA_API_BASE`, `CUA_MODEL`.
- Store secrets in Vercel project settings or a local `.env` consumed by `vercel dev`; never commit secrets.
- Keep timeouts and step limits aligned with `lib/agent/config.ts` defaults unless there's a documented reason to change.
