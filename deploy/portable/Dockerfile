# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}

ARG KALA_VERSION
ARG KALA_REVISION
ARG KALA_SOURCE
ARG KALA_CREATED
ARG KALA_ASSET_SHA256

LABEL org.opencontainers.image.title="Kala Portable" \
      org.opencontainers.image.description="Kala Portable runtime with embedded Dashboard" \
      org.opencontainers.image.version="${KALA_VERSION}" \
      org.opencontainers.image.revision="${KALA_REVISION}" \
      org.opencontainers.image.source="${KALA_SOURCE}" \
      org.opencontainers.image.created="${KALA_CREATED}" \
      io.kala.distribution="portable" \
      io.kala.portable.asset.sha256="${KALA_ASSET_SHA256}"

ENV NODE_ENV=production \
    HOME=/var/lib/kala \
    KALA_BIND_HOST=0.0.0.0 \
    KALA_PORT=3000 \
    KALA_SESSIONS_DIR=/var/lib/kala/sessions \
    KALA_ARTIFACTS_DIR=/var/lib/kala/artifacts \
    KALA_AUDIT_DIR=/var/lib/kala/audit

WORKDIR /opt/kala
COPY --chown=node:node release/kala-dashboard-with-runtime.cjs ./kala-dashboard-with-runtime.cjs

USER root
RUN test -n "${KALA_VERSION}" \
    && test -n "${KALA_REVISION}" \
    && test -n "${KALA_SOURCE}" \
    && test -n "${KALA_CREATED}" \
    && test -n "${KALA_ASSET_SHA256}" \
    && printf '%s  %s\n' "${KALA_ASSET_SHA256}" kala-dashboard-with-runtime.cjs | sha256sum --check --strict \
    && install -d -o node -g node -m 0700 \
       /var/lib/kala \
       /var/lib/kala/sessions \
       /var/lib/kala/artifacts \
       /var/lib/kala/audit

USER node
VOLUME ["/var/lib/kala"]
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/runtime/capabilities').then(r=>{if(!r.ok)throw Error(String(r.status))}).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "/opt/kala/kala-dashboard-with-runtime.cjs"]
