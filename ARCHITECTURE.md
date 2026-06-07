# Bananadoro — Architecture

Bananadoro is **just a timer**. This document describes how that timer behaves
across web, desktop, and mobile, signed-out and signed-in, online and offline.

The governing pattern is **dead reckoning**: state is derived from an anchor +
the wall clock, every participant extrapolates it locally, and an authority
corrects them. A countdown is the easy case — the "trajectory" is deterministic,
so there is nothing to smooth; the only real divergence is clock skew and
events missed while disconnected.

> Scope note: progression / "credit" / Star-Chart is a **separate** product. The
> timer never scores or tracks. Its only hook to that world is emitting a
> `focus-completed` event. See [Non-goals](#non-goals).

---

## 1. The anchor

A timer's truth is one timestamp:

```
endsAt   = absolute unix time the current phase ends   (when running)
remaining= frozen seconds left                          (when paused)
```

Everyone — every device and the server — computes the display as
`endsAt − now`. No ticks are streamed; state changes only on a *command*
(start/pause/reset/skip/settings) or a *phase transition*, both of which are
derivable from `endsAt` + the rules (durations, long-break cadence).

This is what makes sync cheap: you sync **intent** (the last command), not a
stream of countdown values.

---

## 2. Two reckoners

| Reckoner | Role |
|---|---|
| **Device** (web/desktop/mobile client) | Extrapolates `endsAt − now` for display. Can fire the local ding when *it* hits zero (foreground). |
| **Server** (Pulp cell) | The authority. Also extrapolates — and is the **only** reckoner that can fire the deadline event when *no device is connected*, by pushing to the account's devices. |

Conflict rule: **when signed in and online, the server wins.** Firing is
**idempotent** across reckoners — whoever is awake fires, and duplicates
collapse by phase (a phase only transitions once).

Two real sources of divergence, both classic dead-reckoning concerns:

1. **Clock skew** — device clock vs server clock. Fix: the client fetches a
   server-time offset (`GET /app/time`) and renders against corrected time.
2. **Missed events while disconnected** — the server may have crossed a
   deadline (and pushed) while a device was dark. Fix: on reconnect the device
   **snaps to server state**; it does not replay.

---

## 3. Tiered authority

The same engine behaves differently by sign-in × connectivity:

```
                 │  OFFLINE                      │  ONLINE
─────────────────┼───────────────────────────────┼──────────────────────────────────
 SIGNED OUT      │ device owns the clock          │ device owns the clock
 (anonymous)     │ local-first solo (localStorage)│ + anonymous rooms (shared, SSE)
─────────────────┼───────────────────────────────┼──────────────────────────────────
 SIGNED IN       │ run from last-synced copy;     │ SERVER owns the clock (authority)
                 │ reconcile on reconnect         │ + syncs state DOWN to every device
                 │ (offline still works)          │ + PUSHES the ding to all devices
```

Key consequence: **an account does not force "online only."** The device always
keeps a local working copy; the account adds a server authority + push layer on
top, and the server hydrates that copy whenever it can connect. Offline you run
from the last sync (local-first preserved).

---

## 4. The unifying primitive: a timer with members

Solo and "focus together" are **one** thing, not two systems:

```
timer { mode, running, endsAt, round, settings… }
  └─ members: [account…]        (solo = 1 member; troop = N)
       └─ each member has devices
```

A phase transition pushes to **every member's devices**. Solo is a timer whose
single member is you; a troop is a timer with several. Same scheduler, same
push path.

> v1 build target = the **personal** account timer (one durable timer per
> account, pushing to that account's devices). Multi-member troops and folding
> the existing anonymous rooms into this primitive come after. Anonymous rooms
> keep working as-is in the meantime (signed-out, in-memory, SSE).

---

## 5. Components

```
            ┌──────────────────── Pulp host (always-on) ─────────────────────┐
            │   Bananauth cell            Bananadoro cell                     │
 clients    │   ┌────────────┐            ┌──────────────────────────────┐    │
 ┌───────┐  │   │ accounts   │  JWT verify│ account_timers (durable)     │    │
 │ web   │◄─┼──►│ issues JWT │◄──(local)──│ push_devices                 │    │
 │ PWA   │  │   └────────────┘            │ in-mem authority + min-heap  │    │
 ├───────┤  │                             │ scheduler (driven by OnTick) │    │
 │desktop│◄─┼──── SSE (app open) ─────────│  due → advance → persist     │    │
 ├───────┤  │     commands (HTTP, authed) │       → push → broadcast      │    │
 │mobile │  │                             └───────────────┬──────────────┘    │
 └───┬───┘  └─────────────────────────────────────────────┼───────────────────┘
     │   Web Push / VAPID (app CLOSED)  ◄── outbound HTTP ──┘
     ▼
  device notification (the ding) — web / desktop / installed-PWA mobile
```

- **Scheduler** — the host pumps the cell's `pulp_step` continuously (≤10ms,
  with wall-time) even when idle. Fiber surfaces that as `pulp.OnTick`. The cell
  keeps an in-memory next-due index; when `now ≥ soonest endsAt` it advances the
  due timers, persists, fires push, and SSE-broadcasts to any open clients.
  *(Proven: a 1-min timer fired work→break server-side with zero clients.)*
- **Two delivery channels:** SSE while the app is open (live, smooth); Web Push
  when it's closed (the ding + a state nudge).

---

## 6. Data model (bananadoro cell, durable sqlite)

```
account_timers {
  account_id PK, mode, running, ends_at, remaining, round,
  work_secs, break_secs, long_break_secs, long_break_every, auto_start,
  updated_at
}
push_devices {
  id PK, account_id, endpoint, p256dh, auth, created_at, last_seen
}
-- accounts live in Bananauth; bananadoro verifies its JWT locally.
```

Runtime authority is the in-memory copy of `account_timers`, loaded on boot and
persisted on every command/transition. `ends_at` is the scheduler's truth.

---

## 7. Transport: PWA + Web Push (no vendor lock-in)

"Push to a closed app on all platforms" normally means FCM (Google) + APNs
(Apple). We avoid both: **install Bananadoro as a PWA and use Web Push (VAPID),
a W3C standard.**

- **Web + Desktop**: Web Push via service worker; the cell POSTs the encrypted
  payload to the subscription endpoint over its outbound-HTTP capability.
- **Mobile**: an *installed* PWA gets Web Push on Android and on **iOS 16.4+**
  (Add to Home Screen). No FCM/APNs.

Crypto: VAPID = ES256 JWT (RFC 8292); payload = `aes128gcm` (RFC 8291: ECDH
P-256 → HKDF → AES-128-GCM). *(Proven: compiles and runs under wasip1 with a
verified round-trip; `crypto/rand` in-cell is backed by the `entropy.read`
capability.)*

---

## 8. Core flows

1. **Start** — client `POST /app/timer/start` (authed) → cell sets `running`,
   `ends_at = now + remaining`, persists, updates next-due, SSE-broadcasts.
   Client may now close; nothing client-side is required.
2. **Phase end (the point)** — `OnTick` sees `ends_at ≤ now` → advance phase,
   persist, **push to all the account's devices**, SSE-broadcast to any open
   client. No client involved.
3. **Open / switch device** — client fetches snapshot + `GET /app/time` for the
   offset, subscribes to SSE. Server is truth, so all devices agree.
4. **Register device** — on sign-in + notification permission, the client sends
   its push subscription → `push_devices`.
5. **Offline (signed in)** — device runs from its last-synced copy, queues
   commands; on reconnect it pulls server state (which may have advanced/pushed
   while away) and replays its queued intent. Server resolves; most-recent
   command wins, transitions are re-derived from `ends_at`.

---

## 9. Reliability

- **Restart**: rebuild the in-memory index from `account_timers` on boot. For a
  timer whose `ends_at` passed while the host was down, fire the transition once
  on boot (or mark it stale if very old) — never replay a backlog of cycles.
- **Always-on**: with the server owning the clock, host uptime is load-bearing
  for *background* pushes. Foreground devices still self-fire, so a brief outage
  degrades to "ding fires when you next open the app," not silent loss.

---

## 10. Build phases

1. **Durable per-account timer** — schema, models, authed `/app/timer/*`.
2. **Real scheduler** — in-memory next-due, driven by `OnTick` (replaces the
   spike scan).
3. **Clock-offset** — `GET /app/time`.
4. **Device registry + Web Push send** — VAPID, `/app/devices`, encrypt + POST
   via outbound HTTP.
5. **Client as cache** — server-authority rendering when signed in, offline
   fallback + reconcile, service worker + push subscription. Signed-out stays
   local-first.

Each phase is independently verifiable (curl/node for 1–4; browser for 5).

---

## Non-goals

- **Progression / credit / Star-Chart** — a separate service. The timer only
  emits `focus-completed`; it never scores, persists focus history, or judges
  legitimacy.
- **FCM/APNs / native push services** — avoided by going PWA + Web Push.
- **Closed-source / vendor SDKs** — standards over SDKs (the no-lock-in rule).

---

## Proven (spikes, 2026-06-06)

- **Server-side autonomous firing** — `pulp.OnTick` hook in Fiber; a 1-minute
  timer fired `work→break` on the server with **no client connected**.
- **Web Push crypto under wasip1** — VAPID ES256 + RFC 8291 `aes128gcm`
  compiled and ran in the WASI sandbox with a verified round-trip decrypt.
