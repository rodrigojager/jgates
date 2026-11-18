# Rust crates

One file per tool: `<name>.json` with `crate`, `version` and `features`. Installed by `installers/cargo.sh` (`cargo install --locked`) into `/opt/tools/cargo/<name>` (binaries in `bin/`).

Every entry lists in `provides` the programs and libraries it brings (`name` in image.json, `link` on PATH, `path` in the install folder, `version` command and `pattern`, `package`, `pinned`); see the header of `jgates/scripts/image-installs.mjs`. `npm --prefix jgates run image:probe -- <tool>` installs one entry on top of the built image with the same installer the build uses (`../installers/`).
