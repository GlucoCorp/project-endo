# Service images (spec 12.4, ADR-0016). One file for every service:
#   docker build --build-arg SERVICE=api -t endo-api .
# Base images are pinned by digest (7-day release-age rule applies to the upstream Node release).
# The runtime has no shell or package manager, runs as non-root, and its files are root-owned and
# read-only to the service user.

FROM node:24.22.2-trixie-slim@sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d AS build
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /repo
# Corepack fetches the exact pnpm from package.json "packageManager" and verifies its signature.
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/ packages/
COPY services/ services/
ARG SERVICE
RUN test -n "$SERVICE" && grep -q "\"name\": \"@endo/${SERVICE}\"" "services/${SERVICE}/package.json"
# Production dependency closure of this service only (--filter-prod ignores dev-only workspace
# links, e.g. the BFF's test dependency on the API); lockfile must match.
RUN pnpm install --frozen-lockfile --prod --filter-prod "@endo/${SERVICE}..."
# Stage exactly the workspace projects in that closure, plus the installed store, into /out.
RUN mkdir -p /out  && pnpm ls --filter-prod "@endo/${SERVICE}..." --depth -1 --json   | node -e 'for (const p of JSON.parse(require("fs").readFileSync(0, "utf8"))) console.log(require("path").relative("/repo", p.path))'   | while read -r dir; do mkdir -p "/out/$dir" && cp -a "$dir/." "/out/$dir/"; done  && cp -a node_modules package.json /out/  && test -f "/out/services/${SERVICE}/src/main.ts"

# Debian security updates not yet in the pinned distroless base (ADR-0016). apt verifies Debian's
# archive signature and each package's checksum. Each entry is removed once Renovate moves the
# base to a rebuild that contains the fix; Trivy fails the build if a fix is missing.
FROM node:24.22.2-trixie-slim@sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d AS os-patches
# zlib1g: CVE-2026-76844, CVE-2026-85091 (fixed in 1:1.3.dfsg+really1.3.1-1+deb13u1).
ARG OS_PATCHES="zlib1g:1:1.3.dfsg+really1.3.1-1+deb13u1"
RUN apt-get update  && mkdir -p /debs /patch/var/lib/dpkg/status.d  && cd /debs  && for entry in $OS_PATCHES; do       pkg="${entry%%:*}"; min="${entry#*:}";       apt-get download "$pkg";       deb="$(ls /debs/${pkg}_*.deb)";       dpkg --compare-versions "$(dpkg-deb -f "$deb" Version)" ge "$min";       dpkg-deb -x "$deb" /patch;       dpkg-deb -f "$deb" > "/patch/var/lib/dpkg/status.d/$pkg";       dpkg-deb -e "$deb" "/tmp/ctl-$pkg";       cp "/tmp/ctl-$pkg/md5sums" "/patch/var/lib/dpkg/status.d/$pkg.md5sums";     done  && rm -rf /patch/usr/share/doc

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:b8cec4b2f2126ff7bd034ec9ac207ffb3272667dfdc48376e3b035d3270549ba
ARG SERVICE
LABEL org.opencontainers.image.source="https://github.com/GlucoCorp/project-endo" \
      org.opencontainers.image.title="endo-${SERVICE}" \
      org.opencontainers.image.licenses="UNLICENSED"
ENV NODE_ENV=production
# Create /app and its contents as root so the service user cannot modify or replace anything.
USER 0:0
COPY --from=os-patches /patch/ /
WORKDIR /app
COPY --from=build /out/ ./
# The API reads the clinical rule set at startup (spec 7.3); staging and production refuse
# TODO_CLINICAL values. Later milestones mount a signed rule set instead.
COPY clinical/rulesets clinical/rulesets
WORKDIR /app/services/${SERVICE}
USER 65532:65532
# The image's entrypoint is node; services run TypeScript via native type stripping.
CMD ["src/main.ts"]
