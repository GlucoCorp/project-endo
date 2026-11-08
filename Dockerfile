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

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:b8cec4b2f2126ff7bd034ec9ac207ffb3272667dfdc48376e3b035d3270549ba
ARG SERVICE
LABEL org.opencontainers.image.source="https://github.com/GlucoCorp/project-endo" \
      org.opencontainers.image.title="endo-${SERVICE}" \
      org.opencontainers.image.licenses="UNLICENSED"
ENV NODE_ENV=production
# Create /app and its contents as root so the service user cannot modify or replace anything.
USER 0:0
WORKDIR /app
COPY --from=build /out/ ./
# The API reads the clinical rule set at startup (spec 7.3); staging and production refuse
# TODO_CLINICAL values. Later milestones mount a signed rule set instead.
COPY clinical/rulesets clinical/rulesets
WORKDIR /app/services/${SERVICE}
USER 65532:65532
# The image's entrypoint is node; services run TypeScript via native type stripping.
CMD ["src/main.ts"]
