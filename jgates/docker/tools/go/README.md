# Go modules

One file per tool: `<name>.json` with `module`, `version` (without the `v`), `tags`, `ldflags` (`{version}` is replaced; default `-s -w`) and `cgo`. Installed by `installers/go.sh` with the image's Go (`go install`, verified against the Go checksum database) into `/opt/tools/go/<name>`.

Every entry lists in `provides` the programs and libraries it brings (`name` in image.json, `link` on PATH, `path` in the install folder, `version` command and `pattern`, `package`, `pinned`); see the header of `jgates/scripts/image-installs.mjs`. `npm --prefix jgates run image:probe -- <tool>` installs one entry on top of the built image with the same installer the build uses (`../installers/`).
