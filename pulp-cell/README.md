# Bananadoro — Pulp cell

A Go→WASM Pulp cell port of the server-first Pomodoro timer. Replaces the
Bun/TypeScript backend (`../src`) with a single cell running on a Pulp host.

## What changed from the TS backend

| Concern        | Bun/TS original                              | This cell                                            |
| -------------- | -------------------------------------------- | ---------------------------------------------------- |
| Realtime       | `Bun.serve` **WebSocket**, per-socket maps   | **SSE** — host holds streams, cell `Emit`s on change |
| Commands       | WS messages (`start`/`stop`/…)               | **HTTP POST** routes                                  |
| Timing         | 1s `setInterval` broadcast to every client   | **Timestamp** `endsAt`; clients count down locally   |
| Auth           | Lucia + arctic + otplib + nodemailer         | **bananauth** cell (shared HS256 JWT, verified here) |
| Persistence    | `bun:sqlite` + Drizzle                       | `storage.sqlite` + bun (`user_settings`, `user_sessions`) |
| Static serving | `Bun.file` from `public/`                    | `//go:embed public` — single-origin                  |

The phase auto-advance (work↔break at zero) is **tick-free**: WASM cells get
no idle callback, so `Timer.advance` fast-forwards lazily on every command
and on the client's `POST /phase-ended` nudge. See `timer.go`.

## HTTP / SSE contract

Realtime rooms (anonymous):

```
POST /app/session                  → create room, returns state {code,...}
GET  /app/session/:code            → state snapshot (also lazily advances)
GET  /app/session/:code/stream     → SSE; `event: state` on every change
POST /app/session/:code/start
POST /app/session/:code/stop
POST /app/session/:code/reset
POST /app/session/:code/mode       → toggle work/break
POST /app/session/:code/settings   → {workMinutes, breakMinutes}
POST /app/session/:code/phase-ended→ idempotent nudge at local zero
```

Per-user persistence (bananauth JWT via `Authorization: Bearer` or `session`
cookie; writes 401 without it, reads return `null`):

```
GET/POST /app/me/settings          → {workDuration,breakDuration,soundEnabled,notificationsEnabled}
GET/POST /app/me/session           → last-used room code (cross-device)
DELETE   /app/me/data              → clear this app's data (not the account)
```

State payload: `{code, mode, running, endsAt?, remaining, workSecs, breakSecs, userCount}`.
When `running`, clients display `endsAt - now`; otherwise `remaining`.

## Build

```bash
cp -r ../public ./public          # embed the frontend (build step)
GOOS=wasip1 GOARCH=wasm go build -buildmode=c-shared -o bananadoro.wasm .
```

## Run (single cell)

```bash
cd ../pulp-deployment
go build -o bananadoro-host .
HTTP_PORT=3000 JWT_SECRET=dev-secret ./bananadoro-host -manifest ../pulp-cell/pulp.cell.toml
```

## Run alongside bananauth (recommended layout — one host, two cells)

```bash
HTTP_PORT=3000 JWT_SECRET=shared-secret ./bananadoro-host \
  -manifest ../pulp-cell/pulp.cell.toml,../../Bananauth/pulp-cell/pulp.cell.toml
```

Both cells share the host's sqlite and the **same `JWT_SECRET`** — that is
what lets bananadoro verify bananauth's tokens with no network hop.

## TODO (next steps, not in this scaffold)

- **Frontend**: rewrite `public/index.html`'s WebSocket client to
  `EventSource(/app/session/<code>/stream)` + `fetch` POSTs, and add the
  local `endsAt - now` countdown + `/phase-ended` nudge. (Backend is ready.)
- Optional long-poll fallback (`GET /app/session/:code?cursor=`) for proxies
  that strip SSE — mirror Evolution's ring-buffer `Broadcaster`.
- Replace local JWT verify with a sibling `pulp.Call` to bananauth if token
  revocation ever needs to be honored.
