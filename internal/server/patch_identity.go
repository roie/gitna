package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/roie/gitna/internal/protocol"
)

var errStalePatchIdentity = errors.New("server: stale patch identity")

type patchIdentity struct {
	Generation uint64             `json:"generation"`
	Scope      protocol.DiffScope `json:"scope"`
	Path       string             `json:"path"`
	Digest     string             `json:"digest"`
}

func digestPatch(patch string) string {
	sum := sha256.Sum256([]byte(patch))
	return hex.EncodeToString(sum[:])
}

func (s *Server) issuePatchIdentity(generation uint64, scope protocol.DiffScope, path, patch string) (string, error) {
	payload, err := json.Marshal(patchIdentity{
		Generation: generation,
		Scope:      scope,
		Path:       path,
		Digest:     digestPatch(patch),
	})
	if err != nil {
		return "", fmt.Errorf("server: encode patch identity: %w", err)
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, []byte(s.security.Token))
	mac.Write([]byte(encoded))
	signature := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return encoded + "." + signature, nil
}

func (s *Server) verifyPatchIdentity(raw string) (patchIdentity, error) {
	var identity patchIdentity
	separator := -1
	for i := len(raw) - 1; i >= 0; i-- {
		if raw[i] == '.' {
			separator = i
			break
		}
	}
	if separator <= 0 || separator == len(raw)-1 {
		return identity, errStalePatchIdentity
	}
	encoded, encodedSignature := raw[:separator], raw[separator+1:]
	signature, err := base64.RawURLEncoding.DecodeString(encodedSignature)
	if err != nil {
		return identity, errStalePatchIdentity
	}
	mac := hmac.New(sha256.New, []byte(s.security.Token))
	mac.Write([]byte(encoded))
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return identity, errStalePatchIdentity
	}
	payload, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || json.Unmarshal(payload, &identity) != nil {
		return patchIdentity{}, errStalePatchIdentity
	}
	if identity.Generation == 0 || identity.Path == "" || identity.Digest == "" {
		return patchIdentity{}, errStalePatchIdentity
	}
	if identity.Scope != protocol.DiffUnstaged && identity.Scope != protocol.DiffStaged {
		return patchIdentity{}, errStalePatchIdentity
	}
	return identity, nil
}

// validatePatchMutation ties a submitted partial patch to the current full diff.
func (s *Server) validatePatchMutation(ctx context.Context, req mutationRequest) error {
	identity, err := s.verifyPatchIdentity(req.PatchID)
	if err != nil {
		return errStalePatchIdentity
	}
	if identity.Generation != s.gen.Load() || identity.Scope != req.PatchScope || identity.Path != req.PatchPath {
		return errStalePatchIdentity
	}
	expectedReverse := identity.Scope == protocol.DiffStaged
	if req.Reverse != expectedReverse {
		return errStalePatchIdentity
	}

	current, err := s.repo.Diff(ctx, identity.Scope, protocol.DiffOptions{Path: identity.Path})
	if err != nil {
		return err
	}
	if identity.Generation != s.gen.Load() || current.Patch == "" || digestPatch(current.Patch) != identity.Digest {
		return errStalePatchIdentity
	}
	return nil
}
