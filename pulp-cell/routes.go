package main

import (
	"net/http"

	pulpgin "github.com/BananaLabs-OSS/Fiber/pulp/gin"
	"github.com/uptrace/bun"
)

// serverTick is the autonomous scheduler step, driven by the host idle tick
// (pulp.OnTick) — no client required. It fires due account-timer deadlines and
// pushes to the account's devices. Anonymous rooms stay client-driven, so they
// are not scanned here.
func (a *App) serverTick(wallNanos uint64) error {
	a.acct.tick(int64(wallNanos/1e9), a)
	return nil
}

// App holds the cell's shared dependencies and hangs the HTTP handlers.
type App struct {
	cfg  appConfig
	db   *bun.DB
	hub  *Hub          // anonymous, client-driven rooms (signed-out shared sessions)
	acct *AccountStore // durable, server-authoritative per-account timers
}

type cmd int

const (
	cmdStart cmd = iota
	cmdStop
	cmdReset
	cmdToggleMode
)

// CreateRoom mints a new shared room. Optional body overrides the default
// work/break durations. Mirrors the WebSocket "create" message.
func (a *App) CreateRoom(c *pulpgin.Context) {
	var body struct {
		WorkMinutes      int `json:"workMinutes"`
		BreakMinutes     int `json:"breakMinutes"`
		LongBreakMinutes int `json:"longBreakMinutes"`
		LongBreakEvery   int `json:"longBreakEvery"`
	}
	_ = c.ShouldBindJSON(&body) // body optional
	t := a.hub.Create()
	if body.WorkMinutes > 0 || body.BreakMinutes > 0 || body.LongBreakMinutes > 0 || body.LongBreakEvery > 0 {
		t.setDurations(body.WorkMinutes, body.BreakMinutes, body.LongBreakMinutes, body.LongBreakEvery)
	}
	c.JSON(http.StatusOK, t.view(nowSec()))
}

// RoomState returns a fresh snapshot — used by a client right after it opens
// the SSE stream (the "join" path) and on reconnect. Lazily advances phases.
func (a *App) RoomState(c *pulpgin.Context) {
	t := a.hub.Get(c.Param("code"))
	if t == nil {
		c.JSON(http.StatusNotFound, pulpgin.H{"error": "room not found"})
		return
	}
	now := nowSec()
	if t.advance(now) {
		a.hub.broadcast(t, now)
	}
	c.JSON(http.StatusOK, t.view(now))
}

// command builds a handler for the simple state transitions. Every command
// fast-forwards elapsed phases first, then applies the action, then
// broadcasts the new state to the room's SSE subscribers.
func (a *App) command(k cmd) pulpgin.HandlerFunc {
	return func(c *pulpgin.Context) {
		t := a.hub.Get(c.Param("code"))
		if t == nil {
			c.JSON(http.StatusNotFound, pulpgin.H{"error": "room not found"})
			return
		}
		now := nowSec()
		t.advance(now)
		switch k {
		case cmdStart:
			t.start(now)
		case cmdStop:
			t.stop(now)
		case cmdReset:
			t.reset()
		case cmdToggleMode:
			t.toggleMode()
		}
		a.hub.broadcast(t, now)
		c.JSON(http.StatusOK, t.view(now))
	}
}

// RoomSettings updates a room's work/break durations live (the WebSocket
// "settings" message).
func (a *App) RoomSettings(c *pulpgin.Context) {
	t := a.hub.Get(c.Param("code"))
	if t == nil {
		c.JSON(http.StatusNotFound, pulpgin.H{"error": "room not found"})
		return
	}
	var body struct {
		WorkMinutes      int `json:"workMinutes"`
		BreakMinutes     int `json:"breakMinutes"`
		LongBreakMinutes int `json:"longBreakMinutes"`
		LongBreakEvery   int `json:"longBreakEvery"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, pulpgin.H{"error": "invalid body"})
		return
	}
	now := nowSec()
	t.advance(now)
	t.setDurations(body.WorkMinutes, body.BreakMinutes, body.LongBreakMinutes, body.LongBreakEvery)
	a.hub.broadcast(t, now)
	c.JSON(http.StatusOK, t.view(now))
}

// PhaseEnded is the idempotent client nudge fired when a client's local
// countdown reaches zero. The server advances the phase if actually due
// (advance is a no-op otherwise), so duplicate nudges from every client in
// the room collapse to a single transition.
func (a *App) PhaseEnded(c *pulpgin.Context) {
	t := a.hub.Get(c.Param("code"))
	if t == nil {
		c.JSON(http.StatusNotFound, pulpgin.H{"error": "room not found"})
		return
	}
	now := nowSec()
	if t.advance(now) {
		a.hub.broadcast(t, now)
	}
	c.JSON(http.StatusOK, t.view(now))
}
