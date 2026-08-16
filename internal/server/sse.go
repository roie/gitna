package server

import (
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/roie/gitna/internal/watch"
)

const (
	// eventsBufferSize bounds per-subscriber buffering. When a subscriber is
	// slower than the watcher, events are dropped rather than blocking it.
	eventsBufferSize = 16
	// heartbeatInterval is how often idle SSE connections receive a comment so
	// intermediaries do not time them out.
	heartbeatInterval = 15 * time.Second
)

// eventsHub fans invalidation kinds from a single source out to every
// connected subscriber. Slow or disconnected clients never block the source:
// per-subscriber buffers drop events under pressure.
type eventsHub struct {
	src  <-chan watch.InvalidationKind
	mu   sync.Mutex
	subs map[chan watch.InvalidationKind]struct{}
}

func newEventsHub(src <-chan watch.InvalidationKind) *eventsHub {
	h := &eventsHub{
		src:  src,
		subs: make(map[chan watch.InvalidationKind]struct{}),
	}
	if src != nil {
		go h.dispatch()
	}
	return h
}

func (h *eventsHub) dispatch() {
	for k := range h.src {
		h.mu.Lock()
		for ch := range h.subs {
			select {
			case ch <- k:
			default:
			}
		}
		h.mu.Unlock()
	}
}

// subscribe registers a subscriber and returns its event channel along with a
// function that detaches it. The channel is never closed; it is released for
// garbage collection once the subscriber stops reading and the unsubscriber
// has run.
func (h *eventsHub) subscribe() (<-chan watch.InvalidationKind, func()) {
	if h.src == nil {
		ch := make(chan watch.InvalidationKind)
		close(ch)
		return ch, func() {}
	}
	ch := make(chan watch.InvalidationKind, eventsBufferSize)
	h.mu.Lock()
	h.subs[ch] = struct{}{}
	h.mu.Unlock()
	return ch, func() {
		h.mu.Lock()
		delete(h.subs, ch)
		h.mu.Unlock()
	}
}

// handleEvents streams named invalidation events as server-sent events with
// periodic heartbeat comments. The stream ends when the client disconnects or
// the invalidation source closes.
func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "streaming unsupported"})
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")

	events, unsubscribe := s.hub.subscribe()
	defer unsubscribe()

	ticker := time.NewTicker(heartbeatInterval)
	defer ticker.Stop()

	fmt.Fprint(w, ": connected\n\n")
	flusher.Flush()

	for {
		select {
		case <-r.Context().Done():
			return
		case kind, ok := <-events:
			if !ok {
				return
			}
			fmt.Fprintf(w, "event: %s\ndata: {}\n\n", kind)
			flusher.Flush()
		case <-ticker.C:
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		}
	}
}
