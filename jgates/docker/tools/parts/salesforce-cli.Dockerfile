# salesforce-cli: the Salesforce CLI (sf) with its Code Analyzer plugin, both from the npm registry as the exact release tarballs,
# verified against the SHA-512 the registry publishes (a lock file cannot do it: the CLI ships its dependencies bundled inside its
# tarball and the plugin ships an npm-shrinkwrap.json, which pin the whole tree). The plugin is a just-in-time plugin of sf, which
# would download it on first use; here it is installed at build time and registered as a plugin of the CLI, so a run needs no
# network. The engines of the analyzer (PMD, ESLint, regex, CPD, flow, sfge, retire-js) are Node modules and Java jars inside the
# plugin; Java comes from the image (/opt/java, JAVA_HOME). `sf` is a launcher that switches telemetry and update checks off.
FROM fetch AS part-salesforce-cli
# Node to run npm in this stage only (the same release as the node stage of ../Dockerfile; the probe has no such stage); not shipped.
ARG NODE_VERSION=26.13.0
ARG NODE_SHA256_AMD64=d28a96af6c38596f6d9d97c0ee531c13d238d757742387d1928de822d959e997
ARG SALESFORCE_CLI_VERSION=2.158.7
ARG SALESFORCE_CLI_SHA512=d644085a45efbb0eb716b7ab1f4f43211a2bec676f8c0d6cc6bc8af027a97bac9a39f94fdfce6604131fb0778d3f12c4cde4c5e84c340182065297916dbe1ab2
ARG SALESFORCE_CODE_ANALYZER_VERSION=5.16.0
ARG SALESFORCE_CODE_ANALYZER_SHA512=f98c3542988d887be8e86850fe1879be052b62c44dc12ca41e7b7b3213eb9325c0edcd0a3e08f7c0e4a0cc2300083f57b9aece22e2dd362e3eb1e687fc183a97
RUN set -eux; \
    mkdir -p /opt/tools/parts/salesforce-cli /tmp/sf /tmp/node; \
    fetch "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" "${NODE_SHA256_AMD64}" /tmp/node.tar.xz; \
    tar -xJf /tmp/node.tar.xz --strip-components=1 -C /tmp/node; \
    export PATH=/tmp/node/bin:$PATH; \
    fetch "https://registry.npmjs.org/@salesforce/cli/-/cli-${SALESFORCE_CLI_VERSION}.tgz" "${SALESFORCE_CLI_SHA512}" /tmp/sf/cli.tgz; \
    fetch "https://registry.npmjs.org/@salesforce/plugin-code-analyzer/-/plugin-code-analyzer-${SALESFORCE_CODE_ANALYZER_VERSION}.tgz" "${SALESFORCE_CODE_ANALYZER_SHA512}" /tmp/sf/plugin.tgz; \
    printf '%s\n' '{"name":"jgates-tools-salesforce-cli","version":"0.0.0","private":true}' > /opt/tools/parts/salesforce-cli/package.json; \
    cd /opt/tools/parts/salesforce-cli; \
    npm install --ignore-scripts --omit=dev --no-audit --no-fund --no-package-lock --loglevel=error /tmp/sf/cli.tgz /tmp/sf/plugin.tgz; \
    node -e 'const fs=require("fs");const d="node_modules/@salesforce/cli/";const n="@salesforce/plugin-code-analyzer";const j=JSON.parse(fs.readFileSync(d+"package.json","utf8"));if(!j.oclif.plugins.includes(n))j.oclif.plugins.push(n);delete j.oclif.jitPlugins[n];j.dependencies[n]=process.argv[1];fs.writeFileSync(d+"package.json",JSON.stringify(j,null,2)+"\n");const m=JSON.parse(fs.readFileSync(d+"oclif.manifest.json","utf8"));for(const k of Object.keys(m.commands))if(m.commands[k].pluginName===n)delete m.commands[k];fs.writeFileSync(d+"oclif.manifest.json",JSON.stringify(m))' "${SALESFORCE_CODE_ANALYZER_VERSION}"; \
    printf '%s\n' '#!/bin/sh' 'export SF_DISABLE_TELEMETRY=true SF_SKIP_NEW_VERSION_CHECK=true SF_DISABLE_AUTOUPDATE=true SF_AUTOUPDATE_DISABLE=true SF_DISABLE_LOG_FILE=true SF_USE_PROGRESS_BAR=false' 'exec /opt/node/bin/node /opt/tools/parts/salesforce-cli/node_modules/@salesforce/cli/bin/run.js "$@"' > /opt/tools/parts/salesforce-cli/sf; \
    chmod 0555 /opt/tools/parts/salesforce-cli/sf; \
    cp node_modules/@salesforce/cli/LICENSE.txt LICENSE 2>/dev/null || true; \
    rm -rf /tmp/sf /tmp/node /tmp/node.tar.xz /root/.npm; \
    chown -R root:root /opt/tools/parts/salesforce-cli; \
    chmod -R go-w /opt/tools/parts/salesforce-cli
