# Bananadoro

A server-first Pomodoro timer with multi-client support.

## About

Go-to-WASM Pulp cell. Serves an embedded static frontend, anonymous shared
rooms over SSE, and durable per-account timers with Web Push notifications.
Auth is delegated to a co-hosted [Bananauth](../Bananauth) cell (shared HS256
JWT — no service-to-service call needed).

## Tech Stack

- Cell: Go compiled to `wasip1/wasm`, hosted by a custom Pulp host binary
- Realtime: SSE (one stream per room; commands are HTTP POSTs)
- Timing: timestamp-based dead reckoning — no tick loop
- Auth: Bananauth cell (HS256 JWT, verified locally)
- Persistence: `storage.sqlite` (bun ORM) — user settings, last-room, push devices
- Push: Web Push / VAPID (RFC 8291 + 8292) — no FCM/APNs
- Desktop: Tauri v2 shell (Windows; global-shortcut plugin)
- Mobile: Capacitor (Android; LocalNotifications plugin)

## Features

- 25 min work / 5 min break / 15 min long break (configurable)
- Long-break cadence (every N work rounds, default 4)
- Sound effects and desktop/web/mobile notifications
- Anonymous shared rooms — "Focus together" (no sign-in required)
- Per-account server-authoritative timer — syncs across devices, pushes the
  phase-end ding even when the app is closed
- PWA installable on desktop, Android, and iOS 16.4+
- Offline-capable (solo timer runs from localStorage; reconciles on reconnect)

## Build

```bash
# 1. Copy the frontend into the cell embed directory.
cd pulp-cell
cp -r ../public ./public

# 2. Compile the cell to WASM.
GOOS=wasip1 GOARCH=wasm go build -buildmode=c-shared -o bananadoro.wasm .

# 3. Build the host binary.
cd ../pulp-deployment
go build -o bananadoro-host .
```

## Run

```bash
# Single cell (timer only; accounts require a co-hosted bananauth):
HTTP_PORT=3000 JWT_SECRET=dev-secret \
  ./pulp-deployment/bananadoro-host -manifest ./pulp-cell/pulp.cell.toml

# Two cells in one host (recommended; shared sqlite + JWT, no network hop):
HTTP_PORT=3000 JWT_SECRET=shared-secret \
  ./pulp-deployment/bananadoro-host \
  -manifest ./pulp-cell/pulp.cell.toml,../../Bananauth/pulp-cell/pulp.cell.toml
```

## Docker

```bash
# Build context must be the parent GolandProjects/ dir (Go modules use local
# replace directives for sibling Pulp/Fiber repos).
JWT_SECRET=... docker compose up -d --build
```

## License

Proprietary - All rights reserved.
