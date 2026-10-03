package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp/syntax"
	"time"

	"github.com/roie/gitna/internal/protocol"
)

type contentSearchStreamRepo interface {
	SearchContentStream(context.Context, string, bool, bool, bool, bool, string, string, int, func(protocol.ContentSearchFile) error) (protocol.ContentSearchResults, error)
}

type contentSearchFrame struct {
	protocol.ContentSearchResults
	Done   bool   `json:"done"`
	Error  string `json:"error,omitempty"`
	Status int    `json:"status,omitempty"`
	Code   string `json:"code,omitempty"`
}

var errContentStreamLimit = errors.New("content search response byte limit reached")
var errContentStreamInvalidated = errors.New("folder changed while content search was loading")

func (s *Server) streamContentSearch(ctx context.Context, w http.ResponseWriter, r *http.Request, repo contentSearchStreamRepo, query, include, exclude string) {
	generation := s.gen.Load()
	control := http.NewResponseController(w)
	if deadline, ok := ctx.Deadline(); ok {
		// Allow a terminal timeout frame, but bound writes for stalled readers.
		_ = control.SetWriteDeadline(deadline.Add(time.Second))
		defer control.SetWriteDeadline(time.Time{})
	}
	started, bytesWritten := false, 0
	writeFrame := func(frame contentSearchFrame) error {
		data, err := json.Marshal(frame)
		if err != nil {
			return err
		}
		// Reserve space for the terminal frame even when paths/excerpts reach the cap.
		if !frame.Done && bytesWritten+len(data)+1 > (2<<20)-2048 {
			return errContentStreamLimit
		}
		if !started {
			w.Header().Set("Content-Type", "application/x-ndjson")
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("X-Content-Type-Options", "nosniff")
			started = true
		}
		data = append(data, '\n')
		n, err := w.Write(data)
		bytesWritten += n
		if err != nil {
			return err
		}
		if n != len(data) {
			return io.ErrShortWrite
		}
		return control.Flush()
	}
	results, err := repo.SearchContentStream(ctx, query, r.URL.Query().Get("case") == "1", r.URL.Query().Get("includeIgnored") == "1", r.URL.Query().Get("regex") == "1", r.URL.Query().Get("word") == "1", include, exclude, contentSearchMatchLimit, func(file protocol.ContentSearchFile) error {
		if generation != s.gen.Load() {
			return errContentStreamInvalidated
		}
		return writeFrame(contentSearchFrame{ContentSearchResults: protocol.ContentSearchResults{Generation: generation, Results: []protocol.ContentSearchFile{file}}})
	})
	if generation != s.gen.Load() {
		err = errContentStreamInvalidated
	}
	if errors.Is(err, errContentStreamLimit) {
		_ = writeFrame(contentSearchFrame{ContentSearchResults: protocol.ContentSearchResults{Generation: generation, Results: []protocol.ContentSearchFile{}, Truncated: true}, Done: true})
		return
	}
	if err != nil {
		if ctx.Err() != nil && r.Context().Err() != nil {
			return
		}
		status, code := http.StatusInternalServerError, ""
		var patternError *syntax.Error
		if errors.As(err, &patternError) {
			status = http.StatusBadRequest
		}
		if timeoutReached(ctx, err) {
			status, code = http.StatusGatewayTimeout, "search-timeout"
		}
		if errors.Is(err, errContentStreamInvalidated) {
			status, code = http.StatusConflict, "search-invalidated"
		}
		message := err.Error()
		if len(message) > 512 {
			message = message[:512] + "..."
		}
		if !started {
			writeJSON(w, status, map[string]string{"error": message, "code": code})
		} else {
			_ = writeFrame(contentSearchFrame{Done: true, Error: message, Status: status, Code: code})
		}
		return
	}
	results.Generation = generation
	// Files already arrived in ordered frames; never resend the full result set.
	results.Results = []protocol.ContentSearchFile{}
	_ = writeFrame(contentSearchFrame{ContentSearchResults: results, Done: true})
}
