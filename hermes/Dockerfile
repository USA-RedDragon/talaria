# syntax=docker/dockerfile:1

# The upstream image. Both stages and HERMES_BASE_IMAGE use it, so one Renovate bump moves all three.
ARG HERMES_BASE=docker.io/nousresearch/hermes-agent:v0.23.3@sha256:3e9fe4c6ef36490f43aa0d0d80f9df64e9c92a576eee3042f1a97c8813c05355

# Patches are text, so they apply once on the build platform; the image for each
# platform only gets the patched files copied on top of the upstream image.
FROM --platform=$BUILDPLATFORM ${HERMES_BASE} AS patch
COPY scripts/apply-patches.sh /usr/local/bin/apply-patches
COPY patches/ /patches/
RUN apply-patches --image /opt/hermes /patches /out

FROM ${HERMES_BASE}
ARG HERMES_BASE
# The upstream image this one patches, with its digest: clients that need the matching upstream build read it
ENV HERMES_BASE_IMAGE=${HERMES_BASE}
COPY --from=patch /out/ /opt/hermes/
# Upstream's MIT license and the "built on Hermes Agent" notice
COPY LICENSE NOTICE /usr/share/doc/talaria-hermes/
