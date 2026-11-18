# Ruby gems

One folder per tool: `<tool>/Gemfile`, `<tool>/Gemfile.lock` and `<tool>/install.json` (its `provides`, links to the binstubs in `bin/`). Installed by `installers/gem.sh` (Bundler, deployment mode) into `/opt/tools/gem/<tool>`. Needs Ruby and Bundler, brought by an apt entry.

Every entry lists in `provides` the programs and libraries it brings (`name` in image.json, `link` on PATH, `path` in the install folder, `version` command and `pattern`, `package`, `pinned`); see the header of `jgates/scripts/image-installs.mjs`. `npm --prefix jgates run image:probe -- <tool>` installs one entry on top of the built image with the same installer the build uses (`../installers/`).
