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
# The sfge engine of the analyzer bundles netty 4.1.127.Final, whose netty-handler has CVE-2026-75595 (critical, fixed in
# 4.1.137.Final); the engine loads every jar of its java-lib folder (a wildcard class path), so each netty jar is replaced
# by the same artifact of the fixed release from Maven Central, each verified against its SHA-256 below.
ARG NETTY_REPLACED=4.1.127.Final
ARG NETTY_VERSION=4.1.137.Final
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
    lib=node_modules/@salesforce/code-analyzer-sfge-engine/dist/java-lib; \
    printf '%s\n' 'netty-all-4.1.137.Final.jar 3c21d10662148be5e1dc37adea6866faf0e43096a2174c2ef12a4553b45c3af2' \
      'netty-buffer-4.1.137.Final.jar f474b14c7734f15e0540394cb6f39d67777b7581a42919e4ac89d253d4efd929' \
      'netty-codec-4.1.137.Final.jar 9987b6a660b0a6b1f0d791485dae33180b3d1c63687c006fe6d3fd025e9e3798' \
      'netty-codec-dns-4.1.137.Final.jar 2d9a33ce41bd9f6f607df95039e42518a1fca16f83c9bbfe72beb57df6e2489f' \
      'netty-codec-haproxy-4.1.137.Final.jar 5ffa58b94c5ac48fb7e41843c18acf7a268e90b5b85423987829c9291ce3a5df' \
      'netty-codec-http-4.1.137.Final.jar 0535bb5a736472bef5c948d15eb273c4ab9f796656fc7c5d6b982ad92bddbd49' \
      'netty-codec-http2-4.1.137.Final.jar 576ddcfb51b78e86f145c9a52b60e500b1a1d5a257cafec8aa5416ffba044b49' \
      'netty-codec-memcache-4.1.137.Final.jar 3ce5bf2eb871266e93c0bbec050ff814a8641ff4c3b1a21d3fe87523d7940339' \
      'netty-codec-mqtt-4.1.137.Final.jar 4c60d6633cb6f547d30fbb6c94d10f037f59f09261214b70c8763cc66d2941d7' \
      'netty-codec-redis-4.1.137.Final.jar b6952e57e0237c68d20f972695111d93148a6559fee94d2919280ccea984c2f8' \
      'netty-codec-smtp-4.1.137.Final.jar ebf50d91aa43124af1a7318cf3bdb9a84a3d1a7f5c092ff377bc6f012e83f41c' \
      'netty-codec-socks-4.1.137.Final.jar 4a6190e08988c058bfeef2b5965e71946439c771abf721c68f4039b4e7b023e8' \
      'netty-codec-stomp-4.1.137.Final.jar e01124c4dc99d37124ae41a3893226217ba628ad1661424c5a5525959b9fbb63' \
      'netty-codec-xml-4.1.137.Final.jar f4488c827ae8224ef86594851ae1778d9efe1f02d02808d774d21720cc61ed68' \
      'netty-common-4.1.137.Final.jar d31926b01adcc07af86f5e27b81b6d6c115df17d366e835d1fc3f5a1924e7e52' \
      'netty-handler-4.1.137.Final.jar d0e4c6ee4779f59f6ab2fb5d388e4f57147c82270164b37945764bb9bda96a44' \
      'netty-handler-proxy-4.1.137.Final.jar 843de10c4cef34cbc1a5344090f1b57db532fbebf141559862da675f6b656df4' \
      'netty-handler-ssl-ocsp-4.1.137.Final.jar 6a85347e2d598d28da934cc4d8f68b9990ab7052d8366876b820adfa9a5a81df' \
      'netty-resolver-4.1.137.Final.jar b4cf2aeedd9fc7c8c439bbfe574f63cfe5b83392e88bbc07ca0e8424b7cff955' \
      'netty-resolver-dns-4.1.137.Final.jar 898d63ca62ed68ff46543c5344f969424b417f1e8d082fe2bb0181ba10144194' \
      'netty-resolver-dns-classes-macos-4.1.137.Final.jar 92d0a542954475f563ea58221d864884ba6753c50c1f17985b1045e990bf094c' \
      'netty-resolver-dns-native-macos-4.1.137.Final-osx-aarch_64.jar 777e1e9f0337e04388e9f9bd9ff5270e607423be72306b381fd380418b06b9ac' \
      'netty-resolver-dns-native-macos-4.1.137.Final-osx-x86_64.jar bc8a5616ab33f0e640bc6174eea770ccfca8ed0e9891ff3bb3ae638255bc006e' \
      'netty-transport-4.1.137.Final.jar 6251adc2a2921572382732a2db188d4f4f2251fd6ebb49c5d44bbf33d6bfb1a7' \
      'netty-transport-classes-epoll-4.1.137.Final.jar 55049554b799dc8e53bf234fffa36e001f7b5b65c32994b9bd59fc6356f1c52f' \
      'netty-transport-classes-kqueue-4.1.137.Final.jar 88d0ac216f9c7be690a9d0157778570d6f4c61f885863da1fccec7fcaee35557' \
      'netty-transport-native-epoll-4.1.137.Final-linux-aarch_64.jar 82fb63a2dc90c0bddb81e04065a1c06fb4c5be722ad5d64b46491daf8b6f9a01' \
      'netty-transport-native-epoll-4.1.137.Final-linux-riscv64.jar 9d064f9850a85b2893d642eb1a6e42667c1c18d9098a546f231d0108c319df00' \
      'netty-transport-native-epoll-4.1.137.Final-linux-x86_64.jar 185db6053e0e9573d36fa4eb6567b26139afaa4daa7bf5a068e661568304542b' \
      'netty-transport-native-kqueue-4.1.137.Final-osx-aarch_64.jar 6745bb54be0a9105c40c045dcc322b107ac16abf82716963fd64ee921dc5408a' \
      'netty-transport-native-kqueue-4.1.137.Final-osx-x86_64.jar 29f96e4f350df9467e5cf49e83c0be27a094a6a1f6dfc1bf0e0be9af84333729' \
      'netty-transport-native-unix-common-4.1.137.Final.jar 8056e7637f9948f953314894cf995ab664711b66c73c4cd5b593ae84f0b1048c' \
      'netty-transport-rxtx-4.1.137.Final.jar 6422a703bf80bfd15ff9ef84564b47dc5f83e4d31ebf5431f0301304d376aea9' \
      'netty-transport-sctp-4.1.137.Final.jar ff0c2b8999b97c2d078f9685558c6d3ca2207df2e35d30551d29a659bce7d2c5' \
      'netty-transport-udt-4.1.137.Final.jar 28a7fd7a93e51565008747e8929af9f1182f4494cbdd01fe54d5d79081f51b38' > /tmp/netty.txt; \
    while read -r jar sha; do \
      art="${jar%%-${NETTY_VERSION}*}"; rest="${jar#"${art}-${NETTY_VERSION}"}"; \
      [ -e "${lib}/${art}-${NETTY_REPLACED}${rest}" ] || { echo "sfge no longer ships ${art}-${NETTY_REPLACED}${rest}" >&2; exit 1; }; \
      fetch "https://repo1.maven.org/maven2/io/netty/${art}/${NETTY_VERSION}/${jar}" "${sha}" "${lib}/${jar}"; \
      rm -f "${lib}/${art}-${NETTY_REPLACED}${rest}"; \
    done < /tmp/netty.txt; \
    if ls "${lib}" | grep -q "^netty-.*-${NETTY_REPLACED}"; then echo "a netty ${NETTY_REPLACED} jar is left in ${lib}" >&2; exit 1; fi; \
    rm -f /tmp/netty.txt; \
    printf '%s\n' '#!/bin/sh' 'export SF_DISABLE_TELEMETRY=true SF_SKIP_NEW_VERSION_CHECK=true SF_DISABLE_AUTOUPDATE=true SF_AUTOUPDATE_DISABLE=true SF_DISABLE_LOG_FILE=true SF_USE_PROGRESS_BAR=false' 'exec /opt/node/bin/node /opt/tools/parts/salesforce-cli/node_modules/@salesforce/cli/bin/run.js "$@"' > /opt/tools/parts/salesforce-cli/sf; \
    chmod 0555 /opt/tools/parts/salesforce-cli/sf; \
    cp node_modules/@salesforce/cli/LICENSE.txt LICENSE 2>/dev/null || true; \
    rm -rf /tmp/sf /tmp/node /tmp/node.tar.xz /root/.npm; \
    chown -R root:root /opt/tools/parts/salesforce-cli; \
    chmod -R go-w /opt/tools/parts/salesforce-cli
