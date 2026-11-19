# .NET tools

One file per tool: `<name>.json` with `package`, `version` and `sha256` (of the `.nupkg`). Installed offline from the fetched package by `installers/dotnet.sh` into the shared tool path `/opt/dotnet-tools` (on PATH).

Every entry lists in `provides` the programs and libraries it brings (`name` in image.json, `link` on PATH, `path` in the install folder, `version` command and `pattern`, `package`, `pinned`); see the header of `jgates/scripts/image-installs.mjs`. `npm --prefix jgates run image:probe -- <tool>` installs one entry on top of the built image with the same installer the build uses (`../installers/`).
