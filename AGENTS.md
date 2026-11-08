# jgates

## Purpose
This is the product repository of `jgates`: only what the project needs to build, run, test and ship.

## Architecture
An npm workspace with three packages: `jgates/` (TypeScript core, CLI, local server and React UI), `semantic-gate/`
(the AI review gate and its provider integrations) and `quality-gate/` (the legacy deterministic gate and its Docker
sidecar); root `tests/` hold cross-package and package tests.

## Conventions
- Code, identifiers, comments, docs and CLI output are in English; UI strings ship in `messages.en.json` and
  `messages.pt-BR.json`.
- User documentation lives in `docs/jgates/` in both languages; keep both in sync.
- Run `npm test` from the repository root; UI tests run through `npm --prefix jgates run test:ui`.

## Forbidden
- AI working artifacts (plans, ADRs, logs, handoffs, scratch scripts): they belong in the container's `_work/`.
- Restricted third-party rules or credentials in shipped packs.
