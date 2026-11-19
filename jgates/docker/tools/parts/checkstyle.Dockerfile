# checkstyle: the project's self-contained jar plus a one-line launcher (a jar cannot be linked onto PATH). The Java
# runtime is already in the image (/opt/java, JAVA_HOME).
FROM fetch AS part-checkstyle
ARG CHECKSTYLE_VERSION=14.4.0
ARG CHECKSTYLE_SHA256=c0a521e54eabd1ece4ff7bd84cf231b012615745ed3aa4fb27ab0ca73097250c
RUN set -eux; \
    mkdir -p /opt/tools/parts/checkstyle; \
    fetch "https://github.com/checkstyle/checkstyle/releases/download/checkstyle-${CHECKSTYLE_VERSION}/checkstyle-${CHECKSTYLE_VERSION}-all.jar" "${CHECKSTYLE_SHA256}" /opt/tools/parts/checkstyle/checkstyle-all.jar; \
    fetch "https://raw.githubusercontent.com/checkstyle/checkstyle/checkstyle-${CHECKSTYLE_VERSION}/LICENSE" "9b872a8a070b8ad329c4bd380fb1bf0000f564c75023ec8e1e6803f15364b9e9" /opt/tools/parts/checkstyle/LICENSE; \
    printf '%s\n' '#!/bin/sh' 'exec java -jar /opt/tools/parts/checkstyle/checkstyle-all.jar "$@"' > /opt/tools/parts/checkstyle/checkstyle; \
    chmod 0555 /opt/tools/parts/checkstyle/checkstyle; \
    chown -R root:root /opt/tools/parts/checkstyle; \
    chmod -R go-w /opt/tools/parts/checkstyle
