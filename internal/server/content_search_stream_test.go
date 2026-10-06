package server

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/roie/gitna/internal/protocol"
)

type streamSearchStub struct {
	run func(func(protocol.ContentSearchFile) error) (protocol.ContentSearchResults, error)
}

func (r streamSearchStub) SearchContentStream(_ context.Context, _ string, _, _, _, _ bool, _, _ string, _ int, emit func(protocol.ContentSearchFile) error) (protocol.ContentSearchResults, error) {
	return r.run(emit)
}

type deadlineSearchWriter struct {
	*httptest.ResponseRecorder
	deadlines []time.Time
}

func (w *deadlineSearchWriter) SetWriteDeadline(deadline time.Time) error {
	w.deadlines = append(w.deadlines, deadline)
	return nil
}

func TestContentSearchStreamBoundsAndResetsWriteDeadline(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	deadline, _ := ctx.Deadline()
	writer := &deadlineSearchWriter{ResponseRecorder: httptest.NewRecorder()}
	s := &Server{}
	s.streamContentSearch(ctx, writer, httptest.NewRequest("GET", "/?q=x", nil), streamSearchStub{run: func(func(protocol.ContentSearchFile) error) (protocol.ContentSearchResults, error) {
		return protocol.ContentSearchResults{Complete: true}, nil
	}}, "x", "", "")
	if len(writer.deadlines) != 2 || !writer.deadlines[0].Equal(deadline.Add(time.Second)) || !writer.deadlines[1].IsZero() {
		t.Fatalf("write deadlines = %v", writer.deadlines)
	}
}

func TestContentSearchStreamFlushesBeforeCompletion(t *testing.T) {
	s := &Server{}
	s.gen.Store(7)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest("GET", "/?q=needle", nil)
	s.streamContentSearch(t.Context(), recorder, request, streamSearchStub{run: func(emit func(protocol.ContentSearchFile) error) (protocol.ContentSearchResults, error) {
		file := protocol.ContentSearchFile{Path: "a.txt", Matches: []protocol.ContentSearchMatch{{Line: 1, Excerpt: "needle"}}}
		if err := emit(file); err != nil {
			return protocol.ContentSearchResults{}, err
		}
		if !recorder.Flushed || !strings.Contains(recorder.Body.String(), "a.txt") {
			t.Fatal("first match was buffered until completion")
		}
		return protocol.ContentSearchResults{Results: []protocol.ContentSearchFile{file}, Complete: true, SkippedLargeFiles: 2, SkippedLongLines: 3}, nil
	}}, "needle", "", "")
	lines := strings.Split(strings.TrimSpace(recorder.Body.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("frames = %d", len(lines))
	}
	var terminal contentSearchFrame
	if err := json.Unmarshal([]byte(lines[1]), &terminal); err != nil {
		t.Fatal(err)
	}
	if !terminal.Done || !terminal.Complete || terminal.Generation != 7 || len(terminal.Results) != 0 || terminal.SkippedLargeFiles != 2 || terminal.SkippedLongLines != 3 {
		t.Fatalf("terminal = %#v", terminal)
	}
	if recorder.Header().Get("Content-Type") != "application/x-ndjson" {
		t.Fatal("missing stream content type")
	}
}

func TestContentSearchStreamRejectsGenerationChange(t *testing.T) {
	s := &Server{}
	s.gen.Store(1)
	recorder := httptest.NewRecorder()
	s.streamContentSearch(t.Context(), recorder, httptest.NewRequest("GET", "/?q=x", nil), streamSearchStub{run: func(emit func(protocol.ContentSearchFile) error) (protocol.ContentSearchResults, error) {
		if err := emit(protocol.ContentSearchFile{Path: "old.txt", Matches: []protocol.ContentSearchMatch{}}); err != nil {
			return protocol.ContentSearchResults{}, err
		}
		s.gen.Add(1)
		return protocol.ContentSearchResults{Complete: true}, nil
	}}, "x", "", "")
	lines := strings.Split(strings.TrimSpace(recorder.Body.String()), "\n")
	var terminal contentSearchFrame
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &terminal); err != nil {
		t.Fatal(err)
	}
	if !terminal.Done || terminal.Error != errContentStreamInvalidated.Error() || terminal.Code != "search-invalidated" || terminal.Status != 409 || terminal.Complete {
		t.Fatalf("stale success: %#v", terminal)
	}
}

func TestContentSearchStreamTimeout(t *testing.T) {
	s := &Server{}
	recorder := httptest.NewRecorder()
	s.streamContentSearch(t.Context(), recorder, httptest.NewRequest("GET", "/?q=x", nil), streamSearchStub{run: func(emit func(protocol.ContentSearchFile) error) (protocol.ContentSearchResults, error) {
		if err := emit(protocol.ContentSearchFile{Path: "partial.txt", Matches: []protocol.ContentSearchMatch{}}); err != nil {
			return protocol.ContentSearchResults{}, err
		}
		return protocol.ContentSearchResults{}, context.DeadlineExceeded
	}}, "x", "", "")
	lines := strings.Split(strings.TrimSpace(recorder.Body.String()), "\n")
	var terminal contentSearchFrame
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &terminal); err != nil {
		t.Fatal(err)
	}
	if !terminal.Done || terminal.Status != 504 || terminal.Code != "search-timeout" {
		t.Fatalf("timeout: %#v", terminal)
	}
}

func TestContentSearchStreamCapsTransferredBytes(t *testing.T) {
	s := &Server{}
	recorder := httptest.NewRecorder()
	s.streamContentSearch(t.Context(), recorder, httptest.NewRequest("GET", "/?q=x", nil), streamSearchStub{run: func(emit func(protocol.ContentSearchFile) error) (protocol.ContentSearchResults, error) {
		file := protocol.ContentSearchFile{Path: "large.txt", Matches: make([]protocol.ContentSearchMatch, 1000)}
		for i := range file.Matches {
			file.Matches[i].Excerpt = strings.Repeat("x", 1024)
		}
		for range 3 {
			if err := emit(file); err != nil {
				return protocol.ContentSearchResults{}, err
			}
		}
		t.Fatal("byte cap did not stop producer")
		return protocol.ContentSearchResults{}, nil
	}}, "x", "", "")
	if recorder.Body.Len() > 2<<20 {
		t.Fatalf("body = %d bytes", recorder.Body.Len())
	}
	lines := strings.Split(strings.TrimSpace(recorder.Body.String()), "\n")
	var terminal contentSearchFrame
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &terminal); err != nil {
		t.Fatal(err)
	}
	if !terminal.Done || !terminal.Truncated || terminal.Error != "" {
		t.Fatalf("byte cap terminal: %#v", terminal)
	}
}
