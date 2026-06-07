package main

import (
	"time"

	"github.com/uptrace/bun"
)

// UserSettings ports src/app/schema.ts user_settings. One row per account.
type UserSettings struct {
	bun.BaseModel `bun:"table:user_settings"`

	UserID               string    `bun:"user_id,pk" json:"userId"`
	WorkDuration         int       `bun:"work_duration" json:"workDuration"`
	BreakDuration        int       `bun:"break_duration" json:"breakDuration"`
	LongBreakDuration    int       `bun:"long_break_duration" json:"longBreakDuration"`
	LongBreakEvery       int       `bun:"long_break_every" json:"longBreakEvery"`
	AutoStart            bool      `bun:"auto_start" json:"autoStart"`
	SoundEnabled         bool      `bun:"sound_enabled" json:"soundEnabled"`
	NotificationsEnabled bool      `bun:"notifications_enabled" json:"notificationsEnabled"`
	UpdatedAt            time.Time `bun:"updated_at" json:"updatedAt"`
}

// AccountTimer is the durable, server-authoritative timer owned by one account
// (the account-owned model — see ARCHITECTURE.md). Runtime authority is the
// in-memory copy; this row is its durable backing, persisted on every change.
// ends_at is the scheduler's source of truth.
type AccountTimer struct {
	bun.BaseModel `bun:"table:account_timers"`

	AccountID      string    `bun:"account_id,pk" json:"-"`
	Mode           string    `bun:"mode" json:"mode"`
	Running        bool      `bun:"running" json:"running"`
	EndsAt         int64     `bun:"ends_at" json:"endsAt,omitempty"`
	Remaining      int       `bun:"remaining" json:"remaining"`
	Round          int       `bun:"round" json:"round"`
	WorkSecs       int       `bun:"work_secs" json:"workSecs"`
	BreakSecs      int       `bun:"break_secs" json:"breakSecs"`
	LongBreakSecs  int       `bun:"long_break_secs" json:"longBreakSecs"`
	LongBreakEvery int       `bun:"long_break_every" json:"longBreakEvery"`
	AutoStart      bool      `bun:"auto_start" json:"autoStart"`
	UpdatedAt      time.Time `bun:"updated_at" json:"-"`
}

// PushDevice is one Web Push subscription belonging to an account. The cell
// encrypts the phase-end notification to (p256dh, auth) and POSTs it to
// endpoint over its outbound-HTTP capability.
type PushDevice struct {
	bun.BaseModel `bun:"table:push_devices"`

	ID        string    `bun:"id,pk" json:"id"`
	AccountID string    `bun:"account_id" json:"-"`
	Endpoint  string    `bun:"endpoint" json:"endpoint"`
	P256dh    string    `bun:"p256dh" json:"p256dh"`
	Auth      string    `bun:"auth" json:"auth"`
	CreatedAt time.Time `bun:"created_at" json:"-"`
	LastSeen  time.Time `bun:"last_seen" json:"-"`
}

// UserSession ports src/app/schema.ts user_sessions — the user's last-used
// room code, so it can rejoin across devices.
type UserSession struct {
	bun.BaseModel `bun:"table:user_sessions"`

	UserID      string    `bun:"user_id,pk" json:"userId"`
	SessionCode string    `bun:"session_code" json:"sessionCode"`
	UpdatedAt   time.Time `bun:"updated_at" json:"updatedAt"`
}
