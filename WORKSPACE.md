# Product map: jgates

One row per folder (and relevant subfolder) of this repository. Keep it portable: no absolute paths, disks or local-only folders.

| Path | What lives there |
|---|---|
| `jgates/` | TypeScript core, CLI, local server, adapters and React UI |
| `semantic-gate/` | AI semantic gate: providers, context packing, result normalization |
| `quality-gate/` | legacy deterministic gate and its Docker sidecar |
| `docs/jgates/` | user documentation (English and Portuguese) |
| `tests/` | cross-package automated tests and fixtures |
| `scripts/` | scripts the product needs (install, packaging) |
| `examples/` | CI examples shipped with the package |
| `use-jgates-quality/`, `use-jgates-semantic/` | agent skills shipped with the package |

## Allowed Markdown files
- `README.md`
- `AGENTS.md` (root, and folders with their own rules, up to the second level)
- `WORKSPACE.md` (root only)
- `THIRD_PARTY_NOTICES.md`
- `docs/jgates/adapters.en.md`
- `docs/jgates/adapters.pt-BR.md`
- `docs/jgates/agents.en.md`
- `docs/jgates/agents.pt-BR.md`
- `docs/jgates/ci.en.md`
- `docs/jgates/ci.pt-BR.md`
- `docs/jgates/compatibility.en.md`
- `docs/jgates/compatibility.pt-BR.md`
- `docs/jgates/data-folder.en.md`
- `docs/jgates/data-folder.pt-BR.md`
- `docs/jgates/editor.en.md`
- `docs/jgates/editor.pt-BR.md`
- `docs/jgates/gates.en.md`
- `docs/jgates/gates.pt-BR.md`
- `docs/jgates/quality-integrations.en.md`
- `docs/jgates/quality-integrations.pt-BR.md`
- `docs/jgates/semantic-methods.en.md`
- `docs/jgates/semantic-methods.pt-BR.md`
- `docs/jgates/getting-started.en.md`
- `docs/jgates/getting-started.pt-BR.md`
- `docs/jgates/local-ui.en.md`
- `docs/jgates/local-ui.pt-BR.md`
- `docs/jgates/limitations.en.md`
- `docs/jgates/limitations.pt-BR.md`
- `docs/jgates/security.en.md`
- `docs/jgates/security.pt-BR.md`
- `docs/jgates/semantic-gate.en.md`
- `docs/jgates/semantic-mascots.en.md`
- `docs/jgates/semantic-mascots.pt-BR.md`
- `docs/jgates/semantic-gate.pt-BR.md`
- `docs/jgates/templates-and-profiles.en.md`
- `docs/jgates/templates-and-profiles.pt-BR.md`
- `docs/jgates/troubleshooting.en.md`
- `docs/jgates/troubleshooting.pt-BR.md`
- `docs/jgates/services.en.md`
- `docs/jgates/services.pt-BR.md`
- `docs/jgates/storage.en.md`
- `docs/jgates/storage.pt-BR.md`
- `docs/jgates/extension.en.md`
- `docs/jgates/extension.pt-BR.md`
- `docs/jgates/asvs-coverage.en.md`
- `docs/jgates/asvs-coverage.pt-BR.md`
- `jgates/packs/asvs/jgates-asvs-map/NOTICE.md`
- `jgates/packs/semgrep/jgates-semgrep/NOTICE.md`
- `jgates/vendor/owasp-asvs/NOTICE.md`
- `jgates/vendor/cloudflare-security-audit/attack-classes/AI-AND-LLM.md`
- `jgates/vendor/cloudflare-security-audit/attack-classes/ATTACK-CLASSES.md`
- `jgates/vendor/cloudflare-security-audit/attack-classes/CLIENT-SIDE.md`
- `jgates/vendor/cloudflare-security-audit/attack-classes/CLOUD-AND-DEPLOYMENT.md`
- `jgates/vendor/cloudflare-security-audit/attack-classes/DATA-ISOLATION-AND-LIFECYCLE.md`
- `jgates/vendor/cloudflare-security-audit/attack-classes/DESKTOP-MOBILE-AND-LOCAL-IPC.md`
- `jgates/vendor/cloudflare-security-audit/attack-classes/MEMORY-SAFETY-AND-BINARY.md`
- `jgates/vendor/cloudflare-security-audit/attack-classes/PROTOCOLS-RPC-AND-MESSAGING.md`
- `jgates/vendor/cloudflare-security-audit/attack-classes/RESOURCE-EXHAUSTION-AND-AVAILABILITY.md`
- `jgates/vendor/cloudflare-security-audit/attack-classes/SUPPLY-CHAIN-AND-RELEASE.md`
- `jgates/vendor/cloudflare-security-audit/attack-classes/WEB-PROTOCOL-AND-AUTH.md`
- `jgates/vendor/cloudflare-security-audit/NOTICE.md`
- `jgates/vendor/cloudflare-security-audit/prompts/core.md`
- `jgates/vendor/cloudflare-security-audit/prompts/coverage-critic.md`
- `jgates/vendor/cloudflare-security-audit/prompts/coverage-planning.md`
- `jgates/vendor/cloudflare-security-audit/prompts/hunting.md`
- `jgates/vendor/cloudflare-security-audit/prompts/reconnaissance.md`
- `jgates/vendor/cloudflare-security-audit/prompts/refutation.md`
- `jgates/vendor/cloudflare-security-audit/prompts/verification.md`
- `jgates/vendor/trailofbits-skills/differential-review/method.md`
- `jgates/vendor/trailofbits-skills/insecure-defaults/categories/debug-features.md`
- `jgates/vendor/trailofbits-skills/insecure-defaults/categories/default-credentials.md`
- `jgates/vendor/trailofbits-skills/insecure-defaults/categories/fail-open-security.md`
- `jgates/vendor/trailofbits-skills/insecure-defaults/categories/fallback-secrets.md`
- `jgates/vendor/trailofbits-skills/insecure-defaults/categories/permissive-access.md`
- `jgates/vendor/trailofbits-skills/insecure-defaults/method.md`
- `jgates/vendor/trailofbits-skills/NOTICE.md`
- `jgates/vendor/trailofbits-skills/variant-analysis/method.md`
- `jgates/skill/SKILL.md`
- `quality-gate/skill/quality-gate.md`
- `semantic-gate/templates/semantic-review-skill.md`
- `semantic-gate/templates/system-prompt.md`
- `use-jgates-quality/SKILL.md`
- `use-jgates-semantic/SKILL.md`

AI working artifacts live outside this repository, in the container's `_work/` folder.
