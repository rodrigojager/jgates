# Debian packages

One file per group: `<group>.json` with `packages` (Debian package names). From Debian's `main` only (the forbidden-content gate checks the section of every installed package), unpinned: the version is what the probe and image.json record. Installed by `installers/apt.sh` in the final stage, followed by the security updates of everything installed.

Every entry lists in `provides` the programs and libraries it brings (`name` in image.json, `link` on PATH, `path` in the install folder, `version` command and `pattern`, `package`, `pinned`); see the header of `jgates/scripts/image-installs.mjs`. `npm --prefix jgates run image:probe -- <tool>` installs one entry on top of the built image with the same installer the build uses (`../installers/`).
