# Bananadoro — Pulp-cell container.
#
# Builds the timer cell to wasip1 WASM (frontend embedded) and a custom Pulp
# host that serves it, then ships a thin Alpine runtime.
#
# IMPORTANT — build context is the PARENT directory. Both Go modules use local
# `replace => ../../{Fiber,Pulp,Pulp-ext-*}` directives, so the sibling repos
# must be in the build context. Build from the GolandProjects parent, not from
# this repo:
#
#   docker build -f pomodoro-timer/Dockerfile -t bananadoro:latest .
#
# (run with the parent dir as context) — or use the bundled docker-compose.yml,
# which sets `context: ..` for you.
#
# Recommended: add a `.dockerignore` at the build-context root excluding each
# sibling's `.git/`, `node_modules/`, and build artifacts to keep the context
# small. (Not committed here — the context root is the shared parent dir.)

# ---- Stage 1: build the cell to wasip1 WASM (embeds public/) ----
FROM golang:1.25 AS cell
WORKDIR /src
# pulp-cell/go.mod: `replace github.com/BananaLabs-OSS/Fiber => ../../Fiber`
COPY Fiber/ Fiber/
COPY pomodoro-timer/pulp-cell/ pomodoro-timer/pulp-cell/
COPY pomodoro-timer/public/ pomodoro-timer/public/
WORKDIR /src/pomodoro-timer/pulp-cell
# The build embeds public/ via //go:embed — copy the canonical frontend in
# first (mirrors the README build step), then compile.
RUN cp -r ../public ./public \
 && GOOS=wasip1 GOARCH=wasm go build -buildmode=c-shared -o bananadoro.wasm .

# ---- Stage 2: build the Pulp host (pure Go → static, CGO off) ----
FROM golang:1.25 AS host
WORKDIR /src
# pulp-deployment/go.mod: `replace ... => ../../{Pulp,Pulp-ext-*}`
COPY Pulp/ Pulp/
COPY Pulp-ext-entropy/ Pulp-ext-entropy/
COPY Pulp-ext-http/ Pulp-ext-http/
COPY Pulp-ext-sqlite/ Pulp-ext-sqlite/
COPY pomodoro-timer/pulp-deployment/ pomodoro-timer/pulp-deployment/
WORKDIR /src/pomodoro-timer/pulp-deployment
RUN CGO_ENABLED=0 go build -o /out/bananadoro-host .

# ---- Stage 3: runtime ----
FROM alpine:3.20
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY --from=host /out/bananadoro-host       /app/bananadoro-host
COPY --from=cell /src/pomodoro-timer/pulp-cell/bananadoro.wasm /app/cell/bananadoro.wasm
COPY pomodoro-timer/pulp-cell/pulp.cell.toml /app/cell/pulp.cell.toml
COPY pomodoro-timer/docker-entrypoint.sh     /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh && mkdir -p /app/data

# The host reads HTTP_PORT from the environment and writes storage.sqlite to
# ./data (relative to WORKDIR). JWT_SECRET is injected into the manifest by the
# entrypoint and MUST match the bananauth deployment for token verification.
ENV HTTP_PORT=3000
EXPOSE 3000
VOLUME ["/app/data"]
ENTRYPOINT ["/app/docker-entrypoint.sh"]
