# powershell: the PowerShell release archive (pwsh) and the PSScriptAnalyzer module, both from their projects' GitHub
# releases with the published SHA-256. The module is a .nupkg (a zip) kept as a module folder next to pwsh; the
# descriptors import it by that path. libicu comes from the image, so no invariant-globalization switch is needed.
FROM fetch AS part-powershell
ARG POWERSHELL_VERSION=7.7.0
ARG POWERSHELL_SHA256=c89d9c682d2c403dfe726f3df948e359675235a5bd6fab535776de69729ca0cb
ARG PSSCRIPTANALYZER_VERSION=1.25.0
ARG PSSCRIPTANALYZER_SHA256=14e634c828eb98efb9f40b2918ba90f139ed5eccdf663a2a747736d996995d60
RUN set -eux; \
    mkdir -p /opt/tools/parts/powershell /tmp/psa; \
    fetch "https://github.com/PowerShell/PowerShell/releases/download/v${POWERSHELL_VERSION}/powershell-${POWERSHELL_VERSION}-linux-x64.tar.gz" "${POWERSHELL_SHA256}" /tmp/powershell.tar.gz; \
    tar -xzf /tmp/powershell.tar.gz -C /opt/tools/parts/powershell; \
    chmod 0555 /opt/tools/parts/powershell/pwsh; \
    fetch "https://github.com/PowerShell/PSScriptAnalyzer/releases/download/${PSSCRIPTANALYZER_VERSION}/PSScriptAnalyzer.${PSSCRIPTANALYZER_VERSION}.nupkg" "${PSSCRIPTANALYZER_SHA256}" /tmp/psa.nupkg; \
    unzip -q /tmp/psa.nupkg -d /tmp/psa; \
    mkdir -p /opt/tools/parts/powershell/modules; \
    mv /tmp/psa /opt/tools/parts/powershell/modules/PSScriptAnalyzer; \
    rm -rf /opt/tools/parts/powershell/modules/PSScriptAnalyzer/_rels /opt/tools/parts/powershell/modules/PSScriptAnalyzer/package '/opt/tools/parts/powershell/modules/PSScriptAnalyzer/[Content_Types].xml'; \
    rm -f /tmp/powershell.tar.gz /tmp/psa.nupkg; \
    chmod 0555 /opt/tools/parts/powershell/modules/PSScriptAnalyzer/PSScriptAnalyzer.psd1; \
    chown -R root:root /opt/tools/parts/powershell; \
    chmod -R go-w /opt/tools/parts/powershell
