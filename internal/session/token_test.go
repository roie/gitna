package session

import (
	"strings"
	"testing"
)

func TestNewTokenIsURLSafeUnpadded(t *testing.T) {
	tok, err := NewToken()
	if err != nil {
		t.Fatalf("NewToken: %v", err)
	}
	if tok == "" {
		t.Fatal("NewToken returned empty token")
	}
	// 32 random bytes encode to 43 URL-safe base64 characters without padding.
	if len(tok) < 40 {
		t.Fatalf("token length = %d, want >= 40 (32 random bytes)", len(tok))
	}
	for _, r := range tok {
		valid := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9') || r == '-' || r == '_'
		if !valid {
			t.Fatalf("token contains invalid character %q", r)
		}
	}
}

func TestNewTokenUniqueness(t *testing.T) {
	const n = 10000
	seen := make(map[string]struct{}, n)
	for i := 0; i < n; i++ {
		tok, err := NewToken()
		if err != nil {
			t.Fatalf("NewToken: %v", err)
		}
		if _, dup := seen[tok]; dup {
			t.Fatalf("duplicate token generated: %q", tok)
		}
		seen[tok] = struct{}{}
	}
}

func TestNewTokenDoesNotContainPadding(t *testing.T) {
	tok, err := NewToken()
	if err != nil {
		t.Fatalf("NewToken: %v", err)
	}
	if strings.ContainsAny(tok, "=+/") {
		t.Fatalf("token %q contains base64 padding or non-url-safe chars", tok)
	}
}
