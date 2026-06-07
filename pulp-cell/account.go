package main

import (
	"context"
	crand "crypto/rand"
	"encoding/hex"
	"net/http"
	"time"

	pulpgin "github.com/BananaLabs-OSS/Fiber/pulp/gin"
	"github.com/uptrace/bun"
)

// AccountStore is the in-memory authority for durable per-account timers. The
// cell is single-threaded (the host serializes HTTP and idle ticks through
// pulp_step), so no mutex is needed — same contract as the room Hub. The map is
// the runtime truth; the account_timers table is its durable backing.
type AccountStore struct {
	cfg     appConfig
	db      *bun.DB
	timers  map[string]*AccountTimer
	soonest int64 // smallest EndsAt among running timers (0 = none due)
}

func NewAccountStore(cfg appConfig, db *bun.DB) *AccountStore {
	return &AccountStore{cfg: cfg, db: db, timers: map[string]*AccountTimer{}}
}

// load hydrates the in-memory authority from the durable table on boot.
func (s *AccountStore) load(ctx context.Context) error {
	var rows []*AccountTimer
	if err := s.db.NewSelect().Model(&rows).Scan(ctx); err != nil {
		return err
	}
	for _, t := range rows {
		s.timers[t.AccountID] = t
	}
	s.recomputeSoonest()
	return nil
}

func (s *AccountStore) defaultTimer(accountID string) *AccountTimer {
	work := s.cfg.DefaultWorkMinutes * 60
	return &AccountTimer{
		AccountID:      accountID,
		Mode:           modeWork,
		Remaining:      work,
		WorkSecs:       work,
		BreakSecs:      s.cfg.DefaultBreakMinutes * 60,
		LongBreakSecs:  s.cfg.DefaultLongBreakMinutes * 60,
		LongBreakEvery: s.cfg.DefaultLongBreakEvery,
		AutoStart:      true,
	}
}

// get returns the account's timer, materializing an in-memory default if none
// exists yet. A default is not persisted until the first mutation.
func (s *AccountStore) get(accountID string) *AccountTimer {
	t := s.timers[accountID]
	if t == nil {
		t = s.defaultTimer(accountID)
		s.timers[accountID] = t
	}
	return t
}

func (s *AccountStore) persist(t *AccountTimer) {
	t.UpdatedAt = time.Now()
	_, _ = s.db.NewInsert().Model(t).
		On("CONFLICT (account_id) DO UPDATE").
		Set("mode = EXCLUDED.mode").
		Set("running = EXCLUDED.running").
		Set("ends_at = EXCLUDED.ends_at").
		Set("remaining = EXCLUDED.remaining").
		Set("round = EXCLUDED.round").
		Set("work_secs = EXCLUDED.work_secs").
		Set("break_secs = EXCLUDED.break_secs").
		Set("long_break_secs = EXCLUDED.long_break_secs").
		Set("long_break_every = EXCLUDED.long_break_every").
		Set("auto_start = EXCLUDED.auto_start").
		Set("updated_at = EXCLUDED.updated_at").
		Exec(context.Background())
	s.recomputeSoonest()
}

func (s *AccountStore) recomputeSoonest() {
	var min int64
	for _, t := range s.timers {
		if t.Running && (min == 0 || t.EndsAt < min) {
			min = t.EndsAt
		}
	}
	s.soonest = min
}

// tick is the scheduler step, driven by the host idle tick. The soonest-due
// short-circuit makes a quiet cell cost nothing. On a due timer it advances one
// phase (dead reckoning: never replays a backlog), persists, and fires the push.
func (s *AccountStore) tick(now int64, a *App) {
	if s.soonest == 0 || now < s.soonest {
		return
	}
	changed := false
	for _, t := range s.timers {
		if t.Running && t.EndsAt <= now {
			if fired, endingMode := t.advanceDue(now); fired {
				s.persist(t)
				a.fireNotification(t, endingMode, now)
				changed = true
			}
		}
	}
	if changed {
		s.recomputeSoonest()
	}
}

// ---- AccountTimer dead-reckoning operations ----

func (t *AccountTimer) phaseSecs() int {
	return phaseDuration(t.Mode, t.WorkSecs, t.BreakSecs, t.LongBreakSecs)
}

func (t *AccountTimer) remainingAt(now int64) int {
	if !t.Running {
		return t.Remaining
	}
	if r := int(t.EndsAt - now); r > 0 {
		return r
	}
	return 0
}

func (t *AccountTimer) start(now int64) {
	if t.Running {
		return
	}
	if t.Remaining <= 0 {
		t.Remaining = t.phaseSecs()
	}
	t.Running = true
	t.EndsAt = now + int64(t.Remaining)
}

func (t *AccountTimer) pause(now int64) {
	if !t.Running {
		return
	}
	t.Remaining = t.remainingAt(now)
	t.Running = false
	t.EndsAt = 0
}

func (t *AccountTimer) reset() {
	t.Running = false
	t.EndsAt = 0
	t.Remaining = t.phaseSecs()
}

// skip advances to the next phase manually (does not count toward the long-break
// cadence — a skip isn't a completed interval), paused and ready.
func (t *AccountTimer) skip() {
	t.Mode, _ = advancePhase(t.Mode, t.Round, 0) // longBreakEvery=0 → never long, no count
	t.Running = false
	t.EndsAt = 0
	t.Remaining = t.phaseSecs()
}

func (t *AccountTimer) setDurations(workSecs, breakSecs, longBreakSecs, longBreakEvery int, autoStart bool) {
	if workSecs > 0 {
		t.WorkSecs = workSecs
	}
	if breakSecs > 0 {
		t.BreakSecs = breakSecs
	}
	if longBreakSecs > 0 {
		t.LongBreakSecs = longBreakSecs
	}
	if longBreakEvery >= 0 {
		t.LongBreakEvery = longBreakEvery
	}
	t.AutoStart = autoStart
	if !t.Running {
		t.Remaining = t.phaseSecs()
	}
}

// advanceDue fires exactly one phase transition when the deadline has passed.
// If auto-start is on and only this phase elapsed, it chains into the next; if
// more than one phase elapsed (host was down / left unattended) it snaps to a
// clean stopped state rather than replaying — dead-reckoning reconciliation.
func (t *AccountTimer) advanceDue(now int64) (fired bool, endingMode string) {
	if !t.Running || t.EndsAt > now {
		return false, ""
	}
	endingMode = t.Mode
	t.Mode, t.Round = advancePhase(t.Mode, t.Round, t.LongBreakEvery)
	next := t.phaseSecs()
	if t.AutoStart {
		t.EndsAt += int64(next)
		if t.EndsAt <= now { // 2+ phases elapsed → snap clean, no backlog
			t.Running = false
			t.EndsAt = 0
			t.Remaining = next
		}
	} else {
		t.Running = false
		t.EndsAt = 0
		t.Remaining = next
	}
	return true, endingMode
}

func (t *AccountTimer) view(now int64) map[string]any {
	v := map[string]any{
		"mode":           t.Mode,
		"running":        t.Running,
		"remaining":      t.remainingAt(now),
		"round":          t.Round,
		"workSecs":       t.WorkSecs,
		"breakSecs":      t.BreakSecs,
		"longBreakSecs":  t.LongBreakSecs,
		"longBreakEvery": t.LongBreakEvery,
		"autoStart":      t.AutoStart,
		"serverNow":      now, // lets the client correct dead-reckoning clock skew
	}
	if t.Running {
		v["endsAt"] = t.EndsAt
	}
	return v
}

// ---- HTTP handlers (all authed; the account IS the timer) ----

func (a *App) GetTimer(c *pulpgin.Context) {
	uid, ok := a.userID(c)
	if !ok {
		c.JSON(http.StatusUnauthorized, pulpgin.H{"error": "Not logged in"})
		return
	}
	c.JSON(http.StatusOK, a.acct.get(uid).view(nowSec()))
}

func (a *App) timerCommand(apply func(t *AccountTimer, now int64)) pulpgin.HandlerFunc {
	return func(c *pulpgin.Context) {
		uid, ok := a.userID(c)
		if !ok {
			c.JSON(http.StatusUnauthorized, pulpgin.H{"error": "Not logged in"})
			return
		}
		now := nowSec()
		t := a.acct.get(uid)
		apply(t, now)
		a.acct.persist(t)
		c.JSON(http.StatusOK, t.view(now))
	}
}

func (a *App) TimerSettings(c *pulpgin.Context) {
	uid, ok := a.userID(c)
	if !ok {
		c.JSON(http.StatusUnauthorized, pulpgin.H{"error": "Not logged in"})
		return
	}
	var body struct {
		WorkMinutes      float64 `json:"workMinutes"`
		BreakMinutes     float64 `json:"breakMinutes"`
		LongBreakMinutes float64 `json:"longBreakMinutes"`
		LongBreakEvery   int     `json:"longBreakEvery"`
		AutoStart        bool    `json:"autoStart"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, pulpgin.H{"error": "invalid body"})
		return
	}
	now := nowSec()
	t := a.acct.get(uid)
	t.setDurations(int(body.WorkMinutes*60+0.5), int(body.BreakMinutes*60+0.5), int(body.LongBreakMinutes*60+0.5), body.LongBreakEvery, body.AutoStart)
	a.acct.persist(t)
	c.JSON(http.StatusOK, t.view(now))
}

// ServerTime is the dead-reckoning clock-offset source. No auth needed.
func (a *App) ServerTime(c *pulpgin.Context) {
	c.JSON(http.StatusOK, pulpgin.H{"now": time.Now().UnixMilli()})
}

// RegisterDevice stores a Web Push subscription for the account.
func (a *App) RegisterDevice(c *pulpgin.Context) {
	uid, ok := a.userID(c)
	if !ok {
		c.JSON(http.StatusUnauthorized, pulpgin.H{"error": "Not logged in"})
		return
	}
	var body struct {
		Endpoint string `json:"endpoint"`
		Keys     struct {
			P256dh string `json:"p256dh"`
			Auth   string `json:"auth"`
		} `json:"keys"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || body.Endpoint == "" {
		c.JSON(http.StatusBadRequest, pulpgin.H{"error": "invalid subscription"})
		return
	}
	ctx := c.Ctx()
	// De-dupe by endpoint for this account (re-subscribe = upsert).
	_, _ = a.db.NewDelete().Model((*PushDevice)(nil)).
		Where("account_id = ? AND endpoint = ?", uid, body.Endpoint).Exec(ctx)
	dev := &PushDevice{
		ID:        randID(),
		AccountID: uid,
		Endpoint:  body.Endpoint,
		P256dh:    body.Keys.P256dh,
		Auth:      body.Keys.Auth,
		CreatedAt: time.Now(),
		LastSeen:  time.Now(),
	}
	if _, err := a.db.NewInsert().Model(dev).Exec(ctx); err != nil {
		c.JSON(http.StatusInternalServerError, pulpgin.H{"error": "save failed"})
		return
	}
	c.JSON(http.StatusOK, pulpgin.H{"id": dev.ID})
}

func (a *App) UnregisterDevice(c *pulpgin.Context) {
	uid, ok := a.userID(c)
	if !ok {
		c.JSON(http.StatusUnauthorized, pulpgin.H{"error": "Not logged in"})
		return
	}
	var body struct {
		Endpoint string `json:"endpoint"`
	}
	_ = c.ShouldBindJSON(&body)
	_, _ = a.db.NewDelete().Model((*PushDevice)(nil)).
		Where("account_id = ? AND endpoint = ?", uid, body.Endpoint).Exec(c.Ctx())
	c.JSON(http.StatusOK, pulpgin.H{"success": true})
}

func randID() string {
	b := make([]byte, 16)
	_, _ = crand.Read(b)
	return hex.EncodeToString(b)
}
