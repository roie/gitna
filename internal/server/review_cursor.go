package server

import (
	"encoding/base64"
	"encoding/json"
	"errors"

	"github.com/roie/gitna/internal/protocol"
)

var errInvalidReviewCursor = errors.New("invalid review cursor")

type reviewCursor struct {
	Version    int                `json:"v"`
	Generation uint64             `json:"g"`
	Scope      protocol.DiffScope `json:"scope"`
	Commit     string             `json:"commit,omitempty"`
	From       string             `json:"from,omitempty"`
	To         string             `json:"to,omitempty"`
	After      string             `json:"after"`
}

func encodeReviewCursor(cursor reviewCursor) (string, error) {
	encoded, err := json.Marshal(cursor)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(encoded), nil
}

func decodeReviewCursor(raw string) (reviewCursor, error) {
	encoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return reviewCursor{}, errInvalidReviewCursor
	}
	var cursor reviewCursor
	if err := json.Unmarshal(encoded, &cursor); err != nil || cursor.Version != 1 || cursor.After == "" {
		return reviewCursor{}, errInvalidReviewCursor
	}
	return cursor, nil
}

func (cursor reviewCursor) matches(scope protocol.DiffScope, opts protocol.DiffOptions) bool {
	return cursor.Scope == scope && cursor.Commit == opts.Commit && cursor.From == opts.CompareFrom && cursor.To == opts.CompareTo
}
