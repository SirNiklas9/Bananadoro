package main

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	crand "crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"net/url"
	"time"

	"github.com/BananaLabs-OSS/Fiber/pulp"
	pulpgin "github.com/BananaLabs-OSS/Fiber/pulp/gin"
)

var b64url = base64.RawURLEncoding

// fireNotification delivers the phase-end "ding" to all of the account's
// registered devices via Web Push. Called by the scheduler when a deadline
// passes server-side — the client need not be connected.
func (a *App) fireNotification(t *AccountTimer, endingMode string, now int64) {
	if a.cfg.VapidPrivate == "" || a.cfg.VapidPublic == "" {
		return // push not configured
	}
	var devices []*PushDevice
	if err := a.db.NewSelect().Model(&devices).Where("account_id = ?", t.AccountID).Scan(context.Background()); err != nil || len(devices) == 0 {
		return
	}
	title, body := phaseEndMessage(endingMode)
	payload, _ := json.Marshal(map[string]any{
		"title": title, "body": body, "mode": t.Mode, "running": t.Running,
	})
	for _, d := range devices {
		if err := a.sendWebPush(d, payload); err != nil {
			fmt.Printf("[push] send failed account=%s ep=%.40s: %v\n", t.AccountID, d.Endpoint, err)
		} else {
			fmt.Printf("[push] sent account=%s ended=%s\n", t.AccountID, endingMode)
		}
	}
}

func phaseEndMessage(endingMode string) (string, string) {
	if endingMode == modeWork {
		return "Focus complete!", "Time for a break."
	}
	return "Break complete!", "Back to focus."
}

// sendWebPush encrypts payload to the device (RFC 8291 aes128gcm), attaches a
// VAPID Authorization header (RFC 8292), and POSTs to the subscription endpoint
// over the cell's outbound HTTP capability. Prunes the device on 404/410.
func (a *App) sendWebPush(d *PushDevice, payload []byte) error {
	body, err := encryptWebPush(d.P256dh, d.Auth, payload)
	if err != nil {
		return fmt.Errorf("encrypt: %w", err)
	}
	auth, err := a.vapidHeader(d.Endpoint)
	if err != nil {
		return fmt.Errorf("vapid: %w", err)
	}
	resp, err := pulp.HTTP.Fetch(pulp.HTTPFetchRequest{
		Method: "POST",
		URL:    d.Endpoint,
		Headers: map[string]string{
			"TTL":              "120",
			"Content-Encoding": "aes128gcm",
			"Content-Type":     "application/octet-stream",
			"Authorization":    auth,
		},
		Body:    body,
		Timeout: 10 * time.Second,
	})
	if err != nil {
		return err
	}
	if resp.Status == 404 || resp.Status == 410 {
		_, _ = a.db.NewDelete().Model((*PushDevice)(nil)).Where("id = ?", d.ID).Exec(context.Background())
		return fmt.Errorf("subscription gone (status %d), pruned", resp.Status)
	}
	if resp.Status >= 400 {
		return fmt.Errorf("push status %d: %s", resp.Status, string(resp.Body))
	}
	return nil
}

// ---- VAPID (RFC 8292): ES256 JWT + the Authorization header ----

func (a *App) vapidHeader(endpoint string) (string, error) {
	u, err := url.Parse(endpoint)
	if err != nil {
		return "", err
	}
	hdr := b64url.EncodeToString([]byte(`{"typ":"JWT","alg":"ES256"}`))
	claims, _ := json.Marshal(map[string]any{
		"aud": u.Scheme + "://" + u.Host,
		"exp": time.Now().Add(12 * time.Hour).Unix(),
		"sub": a.cfg.VapidSubject,
	})
	signing := hdr + "." + b64url.EncodeToString(claims)

	priv, err := vapidPrivateKey(a.cfg.VapidPrivate)
	if err != nil {
		return "", err
	}
	h := sha256.Sum256([]byte(signing))
	r, s, err := ecdsa.Sign(crand.Reader, priv, h[:])
	if err != nil {
		return "", err
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return "vapid t=" + signing + "." + b64url.EncodeToString(sig) + ", k=" + a.cfg.VapidPublic, nil
}

func vapidPrivateKey(b64 string) (*ecdsa.PrivateKey, error) {
	d, err := b64url.DecodeString(b64)
	if err != nil {
		return nil, err
	}
	priv := new(ecdsa.PrivateKey)
	priv.Curve = elliptic.P256()
	priv.D = new(big.Int).SetBytes(d)
	priv.X, priv.Y = elliptic.P256().ScalarBaseMult(d)
	return priv, nil
}

// ---- RFC 8291 aes128gcm payload encryption ----

func encryptWebPush(p256dhB64, authB64 string, plaintext []byte) ([]byte, error) {
	uaPubBytes, err := b64url.DecodeString(p256dhB64)
	if err != nil {
		return nil, err
	}
	authSecret, err := b64url.DecodeString(authB64)
	if err != nil {
		return nil, err
	}
	uaPub, err := ecdh.P256().NewPublicKey(uaPubBytes)
	if err != nil {
		return nil, err
	}
	as, err := ecdh.P256().GenerateKey(crand.Reader)
	if err != nil {
		return nil, err
	}
	asPub := as.PublicKey().Bytes()
	shared, err := as.ECDH(uaPub)
	if err != nil {
		return nil, err
	}

	keyInfo := []byte("WebPush: info\x00")
	keyInfo = append(keyInfo, uaPubBytes...)
	keyInfo = append(keyInfo, asPub...)
	ikm := hkdfExpand(hkdfExtract(authSecret, shared), keyInfo, 32)

	salt := make([]byte, 16)
	if _, err := crand.Read(salt); err != nil {
		return nil, err
	}
	prk := hkdfExtract(salt, ikm)
	cek := hkdfExpand(prk, []byte("Content-Encoding: aes128gcm\x00"), 16)
	nonce := hkdfExpand(prk, []byte("Content-Encoding: nonce\x00"), 12)

	block, err := aes.NewCipher(cek)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	record := append(plaintext, 0x02) // single-record padding delimiter (RFC 8188)
	ct := gcm.Seal(nil, nonce, record, nil)

	// aes128gcm header: salt(16) | rs(4, BE) | idlen(1) | keyid(asPub) | ciphertext
	out := make([]byte, 0, 21+len(asPub)+len(ct))
	out = append(out, salt...)
	rs := make([]byte, 4)
	binary.BigEndian.PutUint32(rs, 4096)
	out = append(out, rs...)
	out = append(out, byte(len(asPub)))
	out = append(out, asPub...)
	out = append(out, ct...)
	return out, nil
}

func hkdfExtract(salt, ikm []byte) []byte {
	m := hmac.New(sha256.New, salt)
	m.Write(ikm)
	return m.Sum(nil)
}

func hkdfExpand(prk, info []byte, l int) []byte {
	m := hmac.New(sha256.New, prk)
	m.Write(info)
	m.Write([]byte{1})
	return m.Sum(nil)[:l]
}

// VapidPublicKey serves the applicationServerKey the frontend needs to
// PushManager.subscribe(). No auth required.
func (a *App) VapidPublicKey(c *pulpgin.Context) {
	c.JSON(http.StatusOK, pulpgin.H{"publicKey": a.cfg.VapidPublic})
}
