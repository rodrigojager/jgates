# Third-party notices

JGates (this repository, MIT) uses or distributes the components below. Each entry lists the license and the notice the
license asks for. Licenses of installed packages were read from `jgates/node_modules/*/package.json` and the `.venv`
`*.dist-info/METADATA` at the versions pinned in the repository. Where a component is only downloaded into an image
(scanners, MegaLinter) the license is the one the upstream project declares and could not be re-checked offline; those
rows say "upstream, not re-verified offline". Confirm against the upstream `LICENSE` before redistributing an image.

General notice: every component keeps its own copyright, held by its authors. Packages shipped in `node_modules` and
Python wheels carry their own `LICENSE` file, which must stay with any redistributed copy. A component listed as MIT,
ISC, BSD or Apache-2.0 requires its copyright and permission notice (and, for Apache-2.0, the `NOTICE` file when the
package has one) to be kept with copies.

## JGates direct dependencies (`jgates/package.json`)

Runtime (`dependencies`):

| Package | Version | License | Required notice |
| --- | --- | --- | --- |
| `@babel/parser` | 8.0.8 | MIT | Keep the MIT notice. |
| `@codemirror/commands` | 6.11.1 | MIT | Keep the MIT notice. |
| `@codemirror/lang-json` | 6.0.2 | MIT | Keep the MIT notice. |
| `@codemirror/lang-yaml` | 6.1.3 | MIT | Keep the MIT notice. |
| `@codemirror/language` | 6.13.1 | MIT | Keep the MIT notice. |
| `@codemirror/legacy-modes` | 6.5.5 | MIT | Keep the MIT notice. |
| `@codemirror/state` | 6.7.6 | MIT | Keep the MIT notice. |
| `@codemirror/view` | 6.43.15 | MIT | Keep the MIT notice. |
| `@lezer/highlight` | 1.2.5 | MIT | Keep the MIT notice. |
| `ajv` | 8.20.0 | MIT | Keep the MIT notice. |
| `jsonc-parser` | 3.3.1 | MIT | Keep the MIT notice. |
| `react` | 19.3.1 | MIT | Keep the MIT notice (Meta Platforms, Inc.). |
| `react-dom` | 19.3.1 | MIT | Keep the MIT notice (Meta Platforms, Inc.). |
| `recast` | 0.24.0 | MIT | Keep the MIT notice. |
| `three` | 0.187.0 | MIT | Keep the MIT notice (`jgates/ui/public/licenses/three.txt`). |
| `yaml` | 2.9.1 | ISC | Keep the ISC notice. |

Development and build (`devDependencies`, not shipped in `dist/`, except what Vite bundles from the runtime list):

| Package | Version | License | Required notice |
| --- | --- | --- | --- |
| `@axe-core/playwright` | 4.14.0 | MPL-2.0 | Test only. Not redistributed; see the MPL note below. |
| `@playwright/test` | 1.55.0 | Apache-2.0 | Test only. Not redistributed. |
| `@types/node` | 24.13.2 | MIT | Types only. Not redistributed. |
| `@types/react` | 19.3.0 | MIT | Types only. Not redistributed. |
| `@types/react-dom` | 19.3.0 | MIT | Types only. Not redistributed. |
| `@vitejs/plugin-react` | 6.1.2 | MIT | Build only. Not redistributed. |
| `@vitest/coverage-v8` | 5.0.5 | MIT | Test only. Not redistributed. |
| `axe-core` | 4.14.0 | MPL-2.0 | Test only. Not redistributed; see the MPL note below. |
| `dependency-cruiser` | 18.7.0 | MIT | Dev tool, also driven as a user-facing adapter. Keep the MIT notice. |
| `eslint` | 10.13.0 | MIT | Dev tool. Not redistributed. |
| `jscpd` | 5.3.3 | MIT | Dev tool, also driven as an adapter. Keep the MIT notice. |
| `typescript` | 5.9.3 | Apache-2.0 | Build only. Not redistributed. |
| `vite` | 8.3.5 | MIT | Build only. Its runtime helpers that end up in the UI bundle keep the MIT notice. |
| `vitest` | 5.0.5 | MIT | Test only. Not redistributed. |

Limits and notes:

- `@axe-core/playwright` and `axe-core` are MPL-2.0 (file-level copyleft). They are test tools: they are not bundled into
  `jgates/dist/`. If a modified copy of an MPL-licensed file is ever distributed, the changed files must be published under
  the MPL.
- The UI bundle built by Vite includes React, React DOM and the CodeMirror packages; any distribution of `jgates/dist/`
  carries their MIT notices (this file satisfies that for the packages listed here; transitive dependencies of these
  packages are covered by the `LICENSE` files inside `node_modules`).
- Transitive dependencies are not listed one by one. Run a license report over `jgates/package-lock.json` to list them.

## Sidecar direct dependencies (`quality-gate/pyproject.toml`)

| Package | Version | License | Required notice |
| --- | --- | --- | --- |
| `defusedxml` | 0.7.1 | PSF-2.0 (declared as "PSFL" in the metadata) | Keep the Python Software Foundation license text and the Christian Heimes copyright with copies. |
| `tomlkit` | 0.13.3 | MIT | Keep the MIT notice. |

## Scanners and tools (sidecar image, JGates tool images, dev tools)

The sidecar image (`quality-gate/Dockerfile`) is based on MegaLinter and adds the scanners below; the JGates tools image
(`jgates/docker/tools`) carries them too. Licenses marked "upstream" come from the project pages and were
not re-verified offline.

| Component | Version | License | Where | Required notice and limit |
| --- | --- | --- | --- | --- |
| MegaLinter (OX Security) | 9.6.0 | AGPL-3.0 (upstream) | base of the sidecar image | Limit: AGPL-3.0 is network copyleft. The image is the unmodified upstream image plus pinned tools; if the image is redistributed, the corresponding source offer and license text of MegaLinter and of the tools it bundles must go with it. JGates runs the image as a separate process and does not link it. |
| Semgrep (engine, `semgrep`) | 1.170.0 image, 1.182.1 dev | LGPL-2.1-or-later (dev: read from METADATA; image: upstream) | sidecar image, `jgates/dev-tools` | Keep the LGPL notice. JGates only runs the CLI as a separate process. |
| Semgrep Registry rules | rules fetched at run time | Semgrep Rules License v1.0 (upstream) | not bundled | Limit: the registry rules are not under the engine license. The rules license restricts use to internal business purposes and forbids offering the rules as part of a competing product or a hosted service. JGates does not ship the registry rules; a project that enables them accepts those terms itself. |
| Gitleaks | 8.30.1 | MIT (upstream) | sidecar and tools image | Keep the MIT notice. Built from source in the sidecar image. |
| Trivy | 0.72.0 | Apache-2.0 (upstream) | sidecar and tools image | Keep the license and `NOTICE`. Limit: the vulnerability databases Trivy downloads (trivy-db, from GitHub/ghcr) have their own terms; JGates does not ship them. |
| OSV-Scanner | 2.4.0 | Apache-2.0 (upstream) | sidecar and tools image | Keep the license. Limit: it queries OSV.dev data, which carries its own licenses (mostly CC-BY 4.0 or CC0 per source); the data is not bundled. |
| Checkov | 3.3.8 | Apache-2.0 (upstream) | sidecar and tools image | Keep the license. Its policies are part of the package; the hosted Prisma Cloud features are separate and not used. |
| jscpd | 5.0.12 (image), 5.3.3 (dev) | MIT (dev: read from package.json; image: upstream) | sidecar image, dev | Keep the MIT notice. |
| Ruff | 0.17.2 | MIT (read from METADATA) | tools image, dev | Keep the MIT notice. |
| Import Linter (`import-linter`) | 2.15 | BSD-2-Clause (read from METADATA) | dev | Keep the BSD notice. |
| pytest, pytest-cov | 9.1.1, 7.1.0 | MIT (read from METADATA) | dev | Test only. |
| dependency-cruiser | 18.7.0 | MIT | dev | See the table above. |
| ESLint | 10.13.0 | MIT | dev | See the table above. |
| Vitest | 5.0.5 | MIT | dev | See the table above. |
| editorconfig-checker | 3.7.0 | MIT (upstream) | sidecar image (built from source) | Keep the MIT notice. |
| ls-lint | 2.3.1 | MIT (upstream) | sidecar image (built from source) | Keep the MIT notice. |
| protolint | 0.56.4 | MIT (upstream) | sidecar image (built from source) | Keep the MIT notice. |
| websocket-driver | 0.7.5 | Apache-2.0 (upstream) | sidecar image (patched in place) | Keep the license. |
| node-tar (`tar`) | 7.5.19 | BlueOak-1.0.0 / ISC (upstream) | sidecar image (patched in place) | Keep the license. |
| .NET SDK image | 10.0.302 | MIT (upstream) | build stage of the sidecar image | Keep the MIT notice; the Alpine and Microsoft base layers carry their own licenses. |
| Go toolchain (golang image) | 1.25.7 | BSD-3-Clause (upstream) | build stage only | Build only. |
| Python base image (`python:3.12-slim`) | 3.12 | PSF-2.0, with Debian packages under their own licenses | `jgates/docker/*` | Debian package licenses are in `/usr/share/doc/*/copyright` inside the image. |

Other tools that MegaLinter bundles (dozens of linters under many licenses) are not driven by JGates and are not listed
here; their licenses are inside the MegaLinter image.

## Not listed

- Models and providers used by the semantic gate are called over their APIs and are not distributed.
- The vulnerability and rule databases named above are downloaded by the user's run and never stored in this repository.

## Codespell word list for Portuguese

`quality-gate/sidecar/config/codespell-ignore-pt-br.txt` lists the codespell misspelling keys that are valid
Brazilian Portuguese words. It is derived from the VERO pt-BR Hunspell dictionary (LibreOffice dictionaries,
LGPLv3 or MPL), by `quality-gate/scripts/build-codespell-pt-br.py`; keep that notice with the file.

## JGates Semgrep rule pack

`jgates/packs/semgrep/jgates-semgrep` is original JGates work under the MIT license (its `LICENSE` and `NOTICE.md`
travel with it; provenance in `jgates-pack.json`). No rule is copied from another collection, and the official
Semgrep registry rules are never bundled. Semgrep itself (LGPL-2.1) is customer-supplied.

## Quality integrations added in V2

None of these tools is bundled in the npm package. They are customer-supplied or prepared by `jgates doctor --fix` from
the official source into the user's data folder (never during a run); the source, SPDX and official acquisition links are
recorded in each adapter's distribution record (`jgates tools distribution`).

| Tool | License | Mode | Required notice and limit |
| --- | --- | --- | --- |
| zizmor | MIT | prepared from an authorized source | Keep the MIT notice if a copy is redistributed. |
| oasdiff | Apache-2.0 | customer-supplied | Keep the license and `NOTICE`. |
| CodeQL CLI | GitHub CodeQL Terms and Conditions | customer-supplied | Limit: JGates does not ship, bundle or install CodeQL; the customer holds the entitlement for the repository. |
| Schemathesis | MIT | prepared from an authorized source | Keep the MIT notice. |
| OWASP ZAP | Apache-2.0 | customer-supplied (Docker image) | Keep the license. Active scans attack the target; use them only on systems you own. |
| StrykerJS, mutmut | Apache-2.0 (StrykerJS), BSD-3-Clause (mutmut) | customer-supplied | Keep the licenses. |
| govulncheck | BSD-3-Clause | customer-supplied | Limit: it queries the Go vulnerability database, which has its own terms. |
| cargo-audit | MIT OR Apache-2.0 | customer-supplied | Limit: it reads the RustSec advisory database, which has its own terms. |
| cargo, rustc, proptest (cargo-test) | MIT OR Apache-2.0 | customer-supplied | Keep the licenses. proptest is the project's own dev-dependency; JGates only runs `cargo test`. |
| TypeScript, mypy, pyright (build check) | Apache-2.0, MIT, MIT | customer-supplied | Keep the licenses. |

## Three.js

The Quality Gate mascots and the Doctor of the prerequisites bar use Three.js 0.187.0, copyright Three.js authors, under the MIT license. The full license is included at `jgates/ui/public/licenses/three.txt`. Character geometry and animations are procedural local assets.

## Cloudflare security-audit skill (adapted)

`jgates/vendor/cloudflare-security-audit` adapts the security-audit skill of
[cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill) at commit
`c1c8a8c1471069fb0e188eeaff69b8e8db6564a8` (`skills/security-audit`), Copyright (c) 2025-2026 Cloudflare, Inc., under
the MIT license. Its `LICENSE` (the upstream MIT text), `NOTICE.md` (what was kept verbatim and what was adapted) and
`jgates-pack.json` (source, revision, SPDX) travel with it. The Semantic `security-audit` method
(`jgates/src/core/semantic-modules/cloudflare`) is built from that material; the upstream validators and tests are not
shipped (their checks are reimplemented in the module).

## Trail of Bits skills (adapted, CC BY-SA 4.0)

`jgates/vendor/trailofbits-skills` adapts parts of [trailofbits/skills](https://github.com/trailofbits/skills) at commit
`e4dd0bb5b15535f7c5a0834187dffba6ac37e4ff`, made by Trail of Bits, under the Creative Commons Attribution-ShareAlike 4.0
International license (CC-BY-SA-4.0). The `insecure-defaults/categories/` corpora and seed patterns are unchanged; the
three `method.md` files are adaptations of the differential-review, variant-analysis and insecure-defaults plugins and
are licensed CC BY-SA 4.0 as well (ShareAlike). Its `LICENSE` (the full license text), `NOTICE.md` (attribution, the exact
upstream files, every modification and how the ShareAlike and attribution obligations are met) and `jgates-pack.json`
(source, revision, SPDX, modifications, obligations) travel with it; the distribution check refuses a ShareAlike pack
whose record does not state its modifications and obligations. The Semantic methods `differential-review`,
`variant-analysis` and `insecure-defaults` (`jgates/src/core/semantic-modules/`) read this material as data at run time;
the `cross-component` method and the root-cause correlation are original JGates work.

## Tools shipped in the tools image (jgates-tools)

Every tool listed in /etc/jgates/image.json of the image, with its license and the place its source is published.
Tools are installed unmodified, from the pinned release or package, and run only as separate processes: JGates never
links to them. The GPL tools (git, make, rsync, shellcheck, hadolint, golangci-lint, gcc, the Java runtime with its
Classpath Exception) are shipped unmodified; their source is available at the URL of the row and, for Debian packages,
from Debian. The image carries the license and notice files of what it ships in /usr/share/jgates/notices/
(this file, the JGates license, the license files of the Python and Node packages of the tool environments, and the
Debian copyright files). The image build checks every component of its SPDX SBOM against
jgates/docker/tools/license-policy.json: AGPL and unknown licenses fail the build. Never in the image: CodeQL,
the official Semgrep rules, vulnerability databases, MegaLinter, credentials.

| Tool | License | Source |
| --- | --- | --- |
| `cargo` | MIT OR Apache-2.0 | <https://github.com/rust-lang/cargo> |
| `cargo-audit` | Apache-2.0 OR MIT | <https://github.com/rustsec/rustsec> |
| `checkov` | Apache-2.0 | <https://github.com/bridgecrewio/checkov> |
| `clippy` | MIT OR Apache-2.0 | <https://github.com/rust-lang/rust-clippy> |
| `corepack` | MIT | <https://github.com/nodejs/corepack> |
| `coverage` | Apache-2.0 | <https://github.com/nedbat/coveragepy> |
| `curl` | curl | <https://github.com/curl/curl> |
| `dependency-cruiser` | MIT | <https://github.com/sverweij/dependency-cruiser> |
| `dotnet` | MIT | <https://github.com/dotnet/sdk> |
| `dotnet-format` | MIT | <https://github.com/dotnet/format> |
| `eslint` | MIT | <https://github.com/eslint/eslint> |
| `fast-check` | MIT | <https://github.com/dubzzz/fast-check> |
| `gcc` | GPL-3.0-or-later with the GCC Runtime Library Exception | <https://gcc.gnu.org/git.html> |
| `git` | GPL-2.0-only | <https://git.kernel.org/pub/scm/git/git.git> |
| `gitleaks` | MIT | <https://github.com/gitleaks/gitleaks> |
| `go` | BSD-3-Clause | <https://github.com/golang/go> |
| `golangci-lint` | GPL-3.0 | <https://github.com/golangci/golangci-lint> |
| `govulncheck` | BSD-3-Clause | <https://github.com/golang/vuln> |
| `hadolint` | GPL-3.0 | <https://github.com/hadolint/hadolint> |
| `hypothesis` | MPL-2.0 | <https://github.com/HypothesisWorks/hypothesis> |
| `import-linter` | BSD-2-Clause | <https://github.com/seddonym/import-linter> |
| `java` | GPL-2.0-only with the Classpath Exception (Eclipse Temurin JRE) | <https://github.com/adoptium/jdk21u> |
| `jgates` | MIT | <https://github.com/rodrigojager/jgates> |
| `jq` | MIT | <https://github.com/jqlang/jq> |
| `jscpd` | MIT | <https://github.com/kucherenko/jscpd> |
| `make` | GPL-3.0-or-later | <https://git.savannah.gnu.org/cgit/make.git> |
| `mutmut` | BSD-3-Clause | <https://github.com/boxed/mutmut> |
| `mypy` | MIT | <https://github.com/python/mypy> |
| `node` | MIT | <https://github.com/nodejs/node> |
| `npm` | Artistic-2.0 | <https://github.com/npm/cli> |
| `oasdiff` | Apache-2.0 | <https://github.com/oasdiff/oasdiff> |
| `osv-scanner` | Apache-2.0 | <https://github.com/google/osv-scanner> |
| `pkg-config` | ISC (pkgconf) | <https://github.com/pkgconf/pkgconf> |
| `prettier` | MIT | <https://github.com/prettier/prettier> |
| `pyright` | MIT | <https://github.com/microsoft/pyright> |
| `pytest` | MIT | <https://github.com/pytest-dev/pytest> |
| `pytest-cov` | MIT | <https://github.com/pytest-dev/pytest-cov> |
| `python` | PSF-2.0 | <https://github.com/python/cpython> |
| `quality-sidecar` | MIT | <https://github.com/rodrigojager/jgates> |
| `rsync` | GPL-3.0-or-later | <https://github.com/RsyncProject/rsync> |
| `ruff` | MIT | <https://github.com/astral-sh/ruff> |
| `rustc` | MIT OR Apache-2.0 | <https://github.com/rust-lang/rust> |
| `rustfmt` | MIT OR Apache-2.0 | <https://github.com/rust-lang/rustfmt> |
| `rustup` | MIT OR Apache-2.0 | <https://github.com/rust-lang/rustup> |
| `schemathesis` | MIT | <https://github.com/schemathesis/schemathesis> |
| `semgrep` | LGPL-2.1-only (engine only, no Registry rules) | <https://github.com/semgrep/semgrep> |
| `shellcheck` | GPL-3.0-or-later | <https://github.com/koalaman/shellcheck> |
| `squawk` | Apache-2.0 | <https://github.com/sbdchd/squawk> |
| `stryker` | Apache-2.0 | <https://github.com/stryker-mutator/stryker-js> |
| `stryker-jest-runner` | Apache-2.0 | <https://github.com/stryker-mutator/stryker-js> |
| `stryker-vitest-runner` | Apache-2.0 | <https://github.com/stryker-mutator/stryker-js> |
| `tini` | MIT | <https://github.com/krallin/tini> |
| `tomlkit` | MIT | <https://github.com/python-poetry/tomlkit> |
| `trivy` | Apache-2.0 | <https://github.com/aquasecurity/trivy> |
| `typescript` | Apache-2.0 | <https://github.com/microsoft/TypeScript> |
| `typescript-eslint` | MIT | <https://github.com/typescript-eslint/typescript-eslint> |
| `unzip` | Info-ZIP | <https://sourceforge.net/projects/infozip/> |
| `uv` | MIT OR Apache-2.0 | <https://github.com/astral-sh/uv> |
| `vitest` | MIT | <https://github.com/vitest-dev/vitest> |
| `vitest-coverage-v8` | MIT | <https://github.com/vitest-dev/vitest> |
| `xz` | 0BSD (liblzma) and GPL-2.0-or-later (xz tools) | <https://github.com/tukaani-project/xz> |
| `zap` | Apache-2.0 | <https://github.com/zaproxy/zaproxy> |
| `zizmor` | MIT | <https://github.com/zizmorcore/zizmor> |