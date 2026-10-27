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

The sidecar image (`quality-gate/Dockerfile`) is based on MegaLinter and adds the scanners below; `jgates/docker/security`
and `jgates/docker/ruff` are small images with a subset. Licenses marked "upstream" come from the project pages and were
not re-verified offline.

| Component | Version | License | Where | Required notice and limit |
| --- | --- | --- | --- | --- |
| MegaLinter (OX Security) | 9.6.0 | AGPL-3.0 (upstream) | base of the sidecar image | Limit: AGPL-3.0 is network copyleft. The image is the unmodified upstream image plus pinned tools; if the image is redistributed, the corresponding source offer and license text of MegaLinter and of the tools it bundles must go with it. JGates runs the image as a separate process and does not link it. |
| Semgrep (engine, `semgrep`) | 1.170.0 image, 1.182.1 dev | LGPL-2.1-or-later (dev: read from METADATA; image: upstream) | sidecar image, `jgates/dev-tools` | Keep the LGPL notice. JGates only runs the CLI as a separate process. |
| Semgrep Registry rules | rules fetched at run time | Semgrep Rules License v1.0 (upstream) | not bundled | Limit: the registry rules are not under the engine license. The rules license restricts use to internal business purposes and forbids offering the rules as part of a competing product or a hosted service. JGates does not ship the registry rules; a project that enables them accepts those terms itself. |
| Gitleaks | 8.30.1 | MIT (upstream) | sidecar and security image | Keep the MIT notice. Built from source in the sidecar image. |
| Trivy | 0.72.0 | Apache-2.0 (upstream) | sidecar and security image | Keep the license and `NOTICE`. Limit: the vulnerability databases Trivy downloads (trivy-db, from GitHub/ghcr) have their own terms; JGates does not ship them. |
| OSV-Scanner | 2.4.0 | Apache-2.0 (upstream) | sidecar and security image | Keep the license. Limit: it queries OSV.dev data, which carries its own licenses (mostly CC-BY 4.0 or CC0 per source); the data is not bundled. |
| Checkov | 3.3.8 | Apache-2.0 (upstream) | sidecar and security image | Keep the license. Its policies are part of the package; the hosted Prisma Cloud features are separate and not used. |
| jscpd | 5.0.12 (image), 5.3.3 (dev) | MIT (dev: read from package.json; image: upstream) | sidecar image, dev | Keep the MIT notice. |
| Ruff | 0.17.2 | MIT (read from METADATA) | `jgates/docker/ruff`, dev | Keep the MIT notice. |
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
