package main

import (
	"net/http"
	"time"

	pulpgin "github.com/BananaLabs-OSS/Fiber/pulp/gin"
)

// GetSettings returns the signed-in user's saved timer settings, or null
// when not logged in / none saved. Ports src/app/routes.ts GET /settings.
func (a *App) GetSettings(c *pulpgin.Context) {
	uid, ok := a.userID(c)
	if !ok {
		c.JSON(http.StatusOK, nil)
		return
	}
	s := new(UserSettings)
	if err := a.db.NewSelect().Model(s).Where("user_id = ?", uid).Scan(c.Ctx()); err != nil {
		c.JSON(http.StatusOK, nil)
		return
	}
	c.JSON(http.StatusOK, s)
}

// SaveSettings upserts the user's timer settings. Ports POST /settings.
func (a *App) SaveSettings(c *pulpgin.Context) {
	uid, ok := a.userID(c)
	if !ok {
		c.JSON(http.StatusUnauthorized, pulpgin.H{"error": "Not logged in"})
		return
	}
	var body struct {
		WorkDuration         int  `json:"workDuration"`
		BreakDuration        int  `json:"breakDuration"`
		LongBreakDuration    int  `json:"longBreakDuration"`
		LongBreakEvery       int  `json:"longBreakEvery"`
		AutoStart            bool `json:"autoStart"`
		SoundEnabled         bool `json:"soundEnabled"`
		NotificationsEnabled bool `json:"notificationsEnabled"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, pulpgin.H{"error": "invalid body"})
		return
	}
	s := &UserSettings{
		UserID:               uid,
		WorkDuration:         body.WorkDuration,
		BreakDuration:        body.BreakDuration,
		LongBreakDuration:    body.LongBreakDuration,
		LongBreakEvery:       body.LongBreakEvery,
		AutoStart:            body.AutoStart,
		SoundEnabled:         body.SoundEnabled,
		NotificationsEnabled: body.NotificationsEnabled,
		UpdatedAt:            time.Now(),
	}
	_, err := a.db.NewInsert().Model(s).
		On("CONFLICT (user_id) DO UPDATE").
		Set("work_duration = EXCLUDED.work_duration").
		Set("break_duration = EXCLUDED.break_duration").
		Set("long_break_duration = EXCLUDED.long_break_duration").
		Set("long_break_every = EXCLUDED.long_break_every").
		Set("auto_start = EXCLUDED.auto_start").
		Set("sound_enabled = EXCLUDED.sound_enabled").
		Set("notifications_enabled = EXCLUDED.notifications_enabled").
		Set("updated_at = EXCLUDED.updated_at").
		Exec(c.Ctx())
	if err != nil {
		c.JSON(http.StatusInternalServerError, pulpgin.H{"error": "save failed"})
		return
	}
	c.JSON(http.StatusOK, pulpgin.H{"success": true})
}

// GetSessionPref returns the user's last-used room code, or null. Ports
// GET /session.
func (a *App) GetSessionPref(c *pulpgin.Context) {
	uid, ok := a.userID(c)
	if !ok {
		c.JSON(http.StatusOK, nil)
		return
	}
	us := new(UserSession)
	if err := a.db.NewSelect().Model(us).Where("user_id = ?", uid).Scan(c.Ctx()); err != nil {
		c.JSON(http.StatusOK, nil)
		return
	}
	c.JSON(http.StatusOK, us.SessionCode)
}

// SaveSessionPref upserts the user's last-used room code. Ports POST /session.
func (a *App) SaveSessionPref(c *pulpgin.Context) {
	uid, ok := a.userID(c)
	if !ok {
		c.JSON(http.StatusUnauthorized, pulpgin.H{"error": "Not logged in"})
		return
	}
	var body struct {
		SessionCode string `json:"sessionCode"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, pulpgin.H{"error": "invalid body"})
		return
	}
	us := &UserSession{UserID: uid, SessionCode: body.SessionCode, UpdatedAt: time.Now()}
	_, err := a.db.NewInsert().Model(us).
		On("CONFLICT (user_id) DO UPDATE").
		Set("session_code = EXCLUDED.session_code").
		Set("updated_at = EXCLUDED.updated_at").
		Exec(c.Ctx())
	if err != nil {
		c.JSON(http.StatusInternalServerError, pulpgin.H{"error": "save failed"})
		return
	}
	c.JSON(http.StatusOK, pulpgin.H{"success": true})
}

// DeleteData clears the user's app data (settings + last-room). Account
// deletion itself lives in bananauth. Ports DELETE /data.
func (a *App) DeleteData(c *pulpgin.Context) {
	uid, ok := a.userID(c)
	if !ok {
		c.JSON(http.StatusUnauthorized, pulpgin.H{"error": "Not logged in"})
		return
	}
	ctx := c.Ctx()
	_, _ = a.db.NewDelete().Model((*UserSettings)(nil)).Where("user_id = ?", uid).Exec(ctx)
	_, _ = a.db.NewDelete().Model((*UserSession)(nil)).Where("user_id = ?", uid).Exec(ctx)
	c.JSON(http.StatusOK, pulpgin.H{"success": true})
}
