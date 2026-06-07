// Bananadoro — Pulp cell port of the server-first Pomodoro timer.
//
// Replaces the Bun/TypeScript backend (Hono + Bun.serve WebSocket loop +
// Lucia auth) with a single Go→WASM cell:
//
//   - Realtime shared rooms over SSE instead of WebSocket. The host holds
//     the event-streams; the cell only Emits state on change. Commands
//     (start/stop/reset/mode/settings) arrive as plain HTTP POSTs.
//   - Timestamp-based timing instead of a 1s server broadcast loop. WASM
//     cells get no idle-tick callback, so the timer stores an absolute
//     EndsAt and clients count down locally; the server fast-forwards
//     phases lazily on every command + the client's phase-ended nudge.
//   - Auth is delegated to the bananauth cell: this cell verifies the same
//     HS256 session JWT (shared secret) to read account_id. The Lucia +
//     arctic + otplib + nodemailer stack is gone.
//   - Per-user settings + last-room sync persist via storage.sqlite (bun).
//   - The static frontend (public/) is embedded and served single-origin.
//
// Build:
//
//	GOOS=wasip1 GOARCH=wasm go build -buildmode=c-shared -o bananadoro.wasm .
package main

import (
	"context"
	dsql "database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"

	"github.com/BananaLabs-OSS/Fiber/pulp"
	_ "github.com/BananaLabs-OSS/Fiber/pulp/entropy/cryptorand" // wires entropy.read into crypto/rand.Reader
	pulpgin "github.com/BananaLabs-OSS/Fiber/pulp/gin"
	_ "github.com/BananaLabs-OSS/Fiber/pulp/sql" // registers the "pulp" sql driver
	"github.com/uptrace/bun"
	"github.com/uptrace/bun/dialect/sqlitedialect"
)

func main() {}

var (
	db  *bun.DB
	hub *Hub
	app *App
)

func init() {
	pulp.OnInit(bootstrap)
}

func bootstrap(configBytes []byte) error {
	cfg, err := parseConfig(configBytes)
	if err != nil {
		return fmt.Errorf("parse config: %w", err)
	}

	raw, err := dsql.Open("pulp", "")
	if err != nil {
		return fmt.Errorf("open pulp sql driver: %w", err)
	}
	// Single-writer pool — matches the host's pinned sqlite connection and
	// avoids nested-BEGIN races with sibling cells sharing the same file.
	raw.SetMaxOpenConns(1)
	raw.SetMaxIdleConns(1)
	db = bun.NewDB(raw, sqlitedialect.New())

	if err := migrate(context.Background()); err != nil {
		return fmt.Errorf("migrate: %w", err)
	}

	hub = NewHub(cfg)
	app = &App{cfg: cfg, db: db, hub: hub, acct: NewAccountStore(cfg, db)}
	if err := app.acct.load(context.Background()); err != nil {
		return fmt.Errorf("load account timers: %w", err)
	}

	// One SSE pattern, one concrete stream per room. Register before Run —
	// the host begins accepting /app/session/<code>/stream connections now.
	if err := pulp.SSE.Register(ssePattern); err != nil {
		return fmt.Errorf("register sse: %w", err)
	}

	r := pulpgin.New()

	r.GET("/health", func(c *pulpgin.Context) {
		c.JSON(http.StatusOK, pulpgin.H{"service": "bananadoro", "status": "healthy"})
	})

	// Realtime shared rooms — anonymous, like the original WebSocket rooms.
	rooms := r.Group("/app/session")
	rooms.POST("", app.CreateRoom)
	rooms.GET("/:code", app.RoomState)
	rooms.POST("/:code/start", app.command(cmdStart))
	rooms.POST("/:code/stop", app.command(cmdStop))
	rooms.POST("/:code/reset", app.command(cmdReset))
	rooms.POST("/:code/mode", app.command(cmdToggleMode))
	rooms.POST("/:code/settings", app.RoomSettings)
	rooms.POST("/:code/phase-ended", app.PhaseEnded)

	// Authenticated per-user persistence (bananauth JWT required to write).
	me := r.Group("/app/me")
	me.GET("/settings", app.GetSettings)
	me.POST("/settings", app.SaveSettings)
	me.GET("/session", app.GetSessionPref)
	me.POST("/session", app.SaveSessionPref)
	me.DELETE("/data", app.DeleteData)

	// Account-owned, server-authoritative timer (dead reckoning; the scheduler
	// fires deadlines and pushes to devices with no client connected).
	timer := r.Group("/app/timer")
	timer.GET("", app.GetTimer)
	timer.POST("/start", app.timerCommand(func(t *AccountTimer, now int64) { t.start(now) }))
	timer.POST("/stop", app.timerCommand(func(t *AccountTimer, now int64) { t.pause(now) }))
	timer.POST("/reset", app.timerCommand(func(t *AccountTimer, now int64) { t.reset() }))
	timer.POST("/skip", app.timerCommand(func(t *AccountTimer, now int64) { t.skip() }))
	timer.POST("/settings", app.TimerSettings)

	// Dead-reckoning clock-offset source + Web Push device registry + VAPID key.
	r.GET("/app/time", app.ServerTime)
	r.GET("/app/vapid", app.VapidPublicKey)
	devices := r.Group("/app/devices")
	devices.POST("", app.RegisterDevice)
	devices.DELETE("", app.UnregisterDevice)

	// Embedded static frontend, single-origin.
	r.GET("/", serveIndex)
	r.GET("/index.html", serveIndex)
	r.GET("/style.css", serveFileHandler("style.css", "text/css; charset=utf-8"))
	// Service worker must be served from the root scope to control the page.
	r.GET("/sw.js", serveFileHandler("sw.js", "application/javascript; charset=utf-8"))
	r.GET("/manifest.webmanifest", serveFileHandler("manifest.webmanifest", "application/manifest+json; charset=utf-8"))
	r.GET("/images/:file", serveDirHandler("images"))
	r.GET("/sounds/:file", serveDirHandler("sounds"))
	r.GET("/auth-ui/:file", serveDirHandler("auth-ui")) // config-driven Bananauth client

	// Autonomous server-side reckoner: fire room deadlines on the host idle
	// tick, with no client connected. (Spike: proves the account-owned model.)
	pulp.OnTick(app.serverTick)

	if err := r.Run(); err != nil {
		return fmt.Errorf("router: %w", err)
	}
	return nil
}

// appConfig is the decoded [config] table.
type appConfig struct {
	JWTSecret               string
	DefaultWorkMinutes      int
	DefaultBreakMinutes     int
	DefaultLongBreakMinutes int
	DefaultLongBreakEvery   int
	VapidPublic             string // base64url uncompressed P-256 point (also handed to the frontend)
	VapidPrivate            string // base64url 32-byte D scalar
	VapidSubject            string // mailto: or https: contact, per RFC 8292
}

func parseConfig(data []byte) (appConfig, error) {
	cfg := appConfig{DefaultWorkMinutes: 25, DefaultBreakMinutes: 5, DefaultLongBreakMinutes: 15, DefaultLongBreakEvery: 4}
	if len(data) == 0 {
		return cfg, nil
	}
	var rawMap map[string]any
	if err := decodeMsgpack(data, &rawMap); err != nil {
		return cfg, err
	}
	var tmp struct {
		JWTSecret               string `json:"jwt_secret"`
		DefaultWorkMinutes      int    `json:"default_work_minutes"`
		DefaultBreakMinutes     int    `json:"default_break_minutes"`
		DefaultLongBreakMinutes int    `json:"default_long_break_minutes"`
		DefaultLongBreakEvery   int    `json:"default_long_break_every"`
		VapidPublic             string `json:"vapid_public"`
		VapidPrivate            string `json:"vapid_private"`
		VapidSubject            string `json:"vapid_subject"`
	}
	j, _ := json.Marshal(rawMap)
	if err := json.Unmarshal(j, &tmp); err != nil {
		return cfg, err
	}
	cfg.JWTSecret = tmp.JWTSecret
	// Env overlay keeps the secret out of the git-tracked manifest.
	if v := strings.TrimSpace(os.Getenv("JWT_SECRET")); v != "" {
		cfg.JWTSecret = v
	}
	if tmp.DefaultWorkMinutes > 0 {
		cfg.DefaultWorkMinutes = tmp.DefaultWorkMinutes
	}
	if tmp.DefaultBreakMinutes > 0 {
		cfg.DefaultBreakMinutes = tmp.DefaultBreakMinutes
	}
	if tmp.DefaultLongBreakMinutes > 0 {
		cfg.DefaultLongBreakMinutes = tmp.DefaultLongBreakMinutes
	}
	if tmp.DefaultLongBreakEvery > 0 {
		cfg.DefaultLongBreakEvery = tmp.DefaultLongBreakEvery
	}
	cfg.VapidPublic = tmp.VapidPublic
	cfg.VapidPrivate = tmp.VapidPrivate
	cfg.VapidSubject = tmp.VapidSubject
	if cfg.VapidSubject == "" {
		cfg.VapidSubject = "mailto:admin@bananalabs.cloud"
	}
	return cfg, nil
}

func migrate(ctx context.Context) error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS user_settings (
			user_id TEXT PRIMARY KEY,
			work_duration INTEGER NOT NULL DEFAULT 25,
			break_duration INTEGER NOT NULL DEFAULT 5,
			long_break_duration INTEGER NOT NULL DEFAULT 15,
			long_break_every INTEGER NOT NULL DEFAULT 4,
			auto_start INTEGER NOT NULL DEFAULT 1,
			sound_enabled INTEGER NOT NULL DEFAULT 1,
			notifications_enabled INTEGER NOT NULL DEFAULT 1,
			updated_at TIMESTAMP NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS user_sessions (
			user_id TEXT PRIMARY KEY,
			session_code TEXT NOT NULL,
			updated_at TIMESTAMP NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS account_timers (
			account_id TEXT PRIMARY KEY,
			mode TEXT NOT NULL DEFAULT 'work',
			running INTEGER NOT NULL DEFAULT 0,
			ends_at INTEGER NOT NULL DEFAULT 0,
			remaining INTEGER NOT NULL DEFAULT 1500,
			round INTEGER NOT NULL DEFAULT 0,
			work_secs INTEGER NOT NULL DEFAULT 1500,
			break_secs INTEGER NOT NULL DEFAULT 300,
			long_break_secs INTEGER NOT NULL DEFAULT 900,
			long_break_every INTEGER NOT NULL DEFAULT 4,
			auto_start INTEGER NOT NULL DEFAULT 1,
			updated_at TIMESTAMP NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS push_devices (
			id TEXT PRIMARY KEY,
			account_id TEXT NOT NULL,
			endpoint TEXT NOT NULL,
			p256dh TEXT NOT NULL,
			auth TEXT NOT NULL,
			created_at TIMESTAMP NOT NULL,
			last_seen TIMESTAMP NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_push_devices_account ON push_devices(account_id)`,
	}
	for _, s := range stmts {
		if _, err := db.ExecContext(ctx, s); err != nil {
			return fmt.Errorf("migrate exec: %w", err)
		}
	}
	return nil
}
