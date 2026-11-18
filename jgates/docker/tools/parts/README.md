# Parts

For what no other kind fits: `<name>.Dockerfile` defines a stage `part-<name>` (it may start `FROM base` or `FROM fetch`, the stages of `../Dockerfile`) that leaves its result in `/opt/tools/parts/<name>`, and `<name>.json` holds its `version` and `provides`. `image-build.mjs` assembles the Dockerfile it builds from `../Dockerfile` with the parts inserted in name order, and copies each part's folder into the final stage.

Every entry lists in `provides` the programs and libraries it brings (`name` in image.json, `link` on PATH, `path` in the install folder, `version` command and `pattern`, `package`, `pinned`); see the header of `jgates/scripts/image-installs.mjs`. `npm --prefix jgates run image:probe -- <tool>` installs one entry on top of the built image with the same installer the build uses (`../installers/`).
