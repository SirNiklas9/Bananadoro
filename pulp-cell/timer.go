package main

import (
	crand "crypto/rand"
	"encoding/json"
	"time"

	"github.com/BananaLabs-OSS/Fiber/pulp"
)

// Modes a room cycles between.
const (
	modeWork      = "work"
	modeBreak     = "break"
	modeLongBreak = "longBreak"
)

// ssePattern is the single host-registered SSE route. Concrete streams are
// /app/session/<code>/stream — one per room, keyed by code (the same
// pattern Evolution uses for /api/pool/:token/stream).
const ssePattern = "/app/session/:code/stream"

func streamPath(code string) string { return "/app/session/" + code + "/stream" }

// Timer is one shared Pomodoro room. State is timestamp-based: when
// Running, EndsAt is the absolute unix-second the current phase ends and
// clients derive the countdown locally; when paused, Remaining holds the
// frozen seconds left. Single-threaded WASM — no mutex needed.
type Timer struct {
	Code           string
	Mode           string // modeWork | modeBreak | modeLongBreak
	Running        bool
	WorkSecs       int
	BreakSecs      int
	LongBreakSecs  int
	LongBreakEvery int   // a long break replaces the break after this many work intervals (0 disables)
	Round          int   // long-break cadence counter: work intervals since the last long break (not a score)
	EndsAt         int64 // unix sec, valid when Running
	Remaining      int   // sec, valid when !Running
	CreatedAt      int64
}

// Hub owns the live rooms.
type Hub struct {
	cfg      appConfig
	sessions map[string]*Timer
}

func NewHub(cfg appConfig) *Hub {
	return &Hub{cfg: cfg, sessions: make(map[string]*Timer)}
}

func nowSec() int64 { return time.Now().Unix() }

func (h *Hub) Get(code string) *Timer { return h.sessions[code] }

func (h *Hub) Create() *Timer {
	h.prune()
	code := h.uniqueCode()
	work := h.cfg.DefaultWorkMinutes * 60
	brk := h.cfg.DefaultBreakMinutes * 60
	t := &Timer{
		Code:           code,
		Mode:           modeWork,
		WorkSecs:       work,
		BreakSecs:      brk,
		LongBreakSecs:  h.cfg.DefaultLongBreakMinutes * 60,
		LongBreakEvery: h.cfg.DefaultLongBreakEvery,
		Remaining:      work,
		CreatedAt:      nowSec(),
	}
	h.sessions[code] = t
	return t
}

// phaseDuration and advancePhase are the pure timing rules, shared by the
// anonymous room Timer and the durable AccountTimer so both reckon identically.

func phaseDuration(mode string, workSecs, breakSecs, longBreakSecs int) int {
	switch mode {
	case modeWork:
		return workSecs
	case modeLongBreak:
		return longBreakSecs
	default:
		return breakSecs
	}
}

// advancePhase returns the phase following `mode` and the updated long-break
// cadence counter. A finished work interval advances the cadence and, every
// longBreakEvery intervals, yields a long break; a long break resets it.
func advancePhase(mode string, round, longBreakEvery int) (string, int) {
	switch mode {
	case modeWork:
		round++
		if longBreakEvery > 0 && round%longBreakEvery == 0 {
			return modeLongBreak, round
		}
		return modeBreak, round
	case modeLongBreak:
		return modeWork, 0
	default: // modeBreak
		return modeWork, round
	}
}

func (t *Timer) phaseSecs() int {
	return phaseDuration(t.Mode, t.WorkSecs, t.BreakSecs, t.LongBreakSecs)
}

// nextPhase mutates Mode/Round to the phase following the current one. A
// finished work interval advances the long-break cadence and, every
// LongBreakEvery intervals, yields a long break instead of a short one; a long
// break resets the cadence. Round is purely scheduling state, not a score.
func (t *Timer) nextPhase() {
	t.Mode, t.Round = advancePhase(t.Mode, t.Round, t.LongBreakEvery)
}

// advance fast-forwards a running timer to now. The common case is a single
// elapsed phase (the client nudges promptly when its local countdown hits
// zero), which is a clean live transition. If MORE than one phase elapsed,
// the room was left unattended: per the timing-correctness contract we do
// NOT silently replay every cycle — we snap to a clean, stopped state at the
// new phase. WASM cells get no idle-tick, so this is driven lazily from every
// command handler and the client's /phase-ended nudge.
func (t *Timer) advance(now int64) bool {
	if !t.Running || t.EndsAt > now {
		return false
	}
	t.nextPhase()
	t.EndsAt += int64(t.phaseSecs())
	if t.EndsAt <= now {
		// Two or more phases elapsed while unattended — stop cleanly.
		t.Running = false
		t.Remaining = t.phaseSecs()
		t.EndsAt = 0
	}
	return true
}

func (t *Timer) start(now int64) {
	if t.Running {
		return
	}
	t.Running = true
	t.EndsAt = now + int64(t.Remaining)
}

func (t *Timer) stop(now int64) {
	if !t.Running {
		return
	}
	t.advance(now)
	rem := t.EndsAt - now
	if rem < 0 {
		rem = 0
	}
	t.Remaining = int(rem)
	t.Running = false
}

func (t *Timer) reset() {
	t.Running = false
	t.Remaining = t.phaseSecs()
}

// toggleMode is the manual Work/Break switch. Long breaks only arrive via the
// cadence, so the manual control flips between the two interactive phases.
func (t *Timer) toggleMode() {
	if t.Mode == modeWork {
		t.Mode = modeBreak
	} else {
		t.Mode = modeWork
	}
	t.Running = false
	t.Remaining = t.phaseSecs()
}

func (t *Timer) setDurations(workMin, breakMin, longBreakMin, longBreakEvery int) {
	if workMin > 0 {
		t.WorkSecs = workMin * 60
	}
	if breakMin > 0 {
		t.BreakSecs = breakMin * 60
	}
	if longBreakMin > 0 {
		t.LongBreakSecs = longBreakMin * 60
	}
	if longBreakEvery >= 0 {
		t.LongBreakEvery = longBreakEvery
	}
	if !t.Running {
		t.Remaining = t.phaseSecs()
	}
}

// stateView is the wire shape sent on snapshots and SSE broadcasts.
// Clients prefer EndsAt when Running (local countdown), else Remaining.
type stateView struct {
	Code           string `json:"code"`
	Mode           string `json:"mode"`
	Running        bool   `json:"running"`
	EndsAt         int64  `json:"endsAt,omitempty"`
	Remaining      int    `json:"remaining"`
	WorkSecs       int    `json:"workSecs"`
	BreakSecs      int    `json:"breakSecs"`
	LongBreakSecs  int    `json:"longBreakSecs"`
	LongBreakEvery int    `json:"longBreakEvery"`
	Round          int    `json:"round"`
	UserCount      int    `json:"userCount"`
}

func (t *Timer) view(now int64) stateView {
	rem := t.Remaining
	if t.Running {
		rem = int(t.EndsAt - now)
		if rem < 0 {
			rem = 0
		}
	}
	uc, _ := pulp.SSE.SubscriberCount(streamPath(t.Code))
	v := stateView{
		Code:           t.Code,
		Mode:           t.Mode,
		Running:        t.Running,
		Remaining:      rem,
		WorkSecs:       t.WorkSecs,
		BreakSecs:      t.BreakSecs,
		LongBreakSecs:  t.LongBreakSecs,
		LongBreakEvery: t.LongBreakEvery,
		Round:          t.Round,
		UserCount:      int(uc),
	}
	if t.Running {
		v.EndsAt = t.EndsAt
	}
	return v
}

// broadcast pushes the current state to every SSE subscriber of the room.
func (h *Hub) broadcast(t *Timer, now int64) {
	data, err := json.Marshal(t.view(now))
	if err != nil {
		return
	}
	_ = pulp.SSE.Emit(streamPath(t.Code), "", "state", string(data))
}

// Room codes avoid visually ambiguous characters (no O/0/I/1/L).
const (
	codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	codeLen      = 6
	roomTTLSec   = 24 * 60 * 60
)

func generateCode() string {
	b := make([]byte, codeLen)
	_, _ = crand.Read(b) // crypto/rand via entropy.read capability
	out := make([]byte, codeLen)
	for i := range b {
		out[i] = codeAlphabet[int(b[i])%len(codeAlphabet)]
	}
	return string(out)
}

func (h *Hub) uniqueCode() string {
	for {
		c := generateCode()
		if _, exists := h.sessions[c]; !exists {
			return c
		}
	}
}

// prune drops rooms older than the TTL that have no live SSE subscribers.
// Tick-free: runs opportunistically on Create (the original deleted empty
// rooms after 24h via setTimeout, which WASM cannot schedule).
func (h *Hub) prune() {
	now := nowSec()
	for code, t := range h.sessions {
		if now-t.CreatedAt < roomTTLSec {
			continue
		}
		if pulp.SSE.HasSubscribers(streamPath(code)) {
			continue
		}
		delete(h.sessions, code)
	}
}
