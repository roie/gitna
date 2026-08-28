// Package session provides per-process capability tokens for browser sessions.
package session

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
)

// NewToken returns a 22-character URL-safe, unpadded capability token derived
// from 128 bits of cryptographically secure randomness. The token is passed in
// the session URL and required on every API route.
func NewToken() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("session: generate token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}
