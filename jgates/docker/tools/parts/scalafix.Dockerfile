# scalafix: the standalone launcher, built here with coursier (a static binary, used only in this stage and not shipped). The
# launcher is one executable jar with the whole dependency tree inside; it runs on the image's Java runtime (/opt/java).
FROM fetch AS part-scalafix
ARG COURSIER_VERSION=2.1.26
ARG COURSIER_SHA256=21021ff6689637bd0fce276c91171aabe67c70c72a3c805e6daddbc9ca58f6c4
ARG SCALAFIX_VERSION=0.14.10
ARG SCALAFIX_SCALA=2.13.18
RUN set -eux; \
    mkdir -p /opt/tools/parts/scalafix /tmp/cs; \
    fetch "https://github.com/coursier/coursier/releases/download/v${COURSIER_VERSION}/cs-x86_64-pc-linux-static.gz" "${COURSIER_SHA256}" /tmp/cs/cs.gz; \
    gzip -d /tmp/cs/cs.gz; chmod 0755 /tmp/cs/cs; \
    COURSIER_CACHE=/tmp/cs/cache /tmp/cs/cs bootstrap --standalone --repository central -o /opt/tools/parts/scalafix/scalafix "ch.epfl.scala:scalafix-cli_${SCALAFIX_SCALA}:${SCALAFIX_VERSION}" --main scalafix.cli.Cli; \
    fetch "https://raw.githubusercontent.com/scalacenter/scalafix/v${SCALAFIX_VERSION}/LICENSE.md" "48299fd5f7a1a62989aed16453ee3019011ac4184a991396fa071e555a435f50" /opt/tools/parts/scalafix/LICENSE; \
    chmod 0555 /opt/tools/parts/scalafix/scalafix; \
    chown -R root:root /opt/tools/parts/scalafix; \
    chmod -R go-w /opt/tools/parts/scalafix; \
    rm -rf /tmp/cs
