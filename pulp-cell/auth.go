package main

import (
	"strings"

	pulpgin "github.com/BananaLabs-OSS/Fiber/pulp/gin"
	"github.com/golang-jwt/jwt/v5"
)

// sessionClaims mirrors the JWT shape bananauth issues (HS256, account_id
// alongside the registered claims). Keeping this in sync with
// Bananauth/pulp-cell/sessions.go is what lets bananadoro authenticate a
// user without a round-trip to the auth cell.
type sessionClaims struct {
	jwt.RegisteredClaims
	AccountID string `json:"account_id"`
}

// userID verifies the bananauth session token and returns its account_id.
// The token is read from the Authorization: Bearer header or a "session"
// cookie. Returns ("", false) on any verification failure — callers decide
// whether that is a 401 (writes) or a null body (optional reads).
//
// This trusts the token's signature + expiry only; it does not consult
// bananauth's in-memory revocation list. For a Pomodoro timer that trade
// is fine. If revocation ever matters, swap this for a sibling pulp.Call to
// bananauth's /auth/session and add `consumes = ["bananauth"]` to the
// manifest.
func (a *App) userID(c *pulpgin.Context) (string, bool) {
	tok := bearerToken(c)
	if tok == "" {
		return "", false
	}
	claims := &sessionClaims{}
	parsed, err := jwt.ParseWithClaims(tok, claims, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, jwt.ErrSignatureInvalid
		}
		return []byte(a.cfg.JWTSecret), nil
	})
	if err != nil || !parsed.Valid || claims.AccountID == "" {
		return "", false
	}
	return claims.AccountID, true
}

func bearerToken(c *pulpgin.Context) string {
	if h := c.GetHeader("Authorization"); h != "" {
		if t, ok := strings.CutPrefix(h, "Bearer "); ok {
			return strings.TrimSpace(t)
		}
	}
	if ck, err := c.Cookie("session"); err == nil && ck != "" {
		return ck
	}
	return ""
}
