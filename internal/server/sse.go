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
	src                  <-chan watch.InvalidationKind
	onEvent              func(watch.InvalidationKind)
	onSubscribersChanged func(int)
	done                 chan struct{}
	mu                   sync.Mutex
	subs                 map[chan watch.InvalidationKind]struct{}
}

func newEventsHub(src <-chan watch.InvalidationKind, onSubscribersChanged ...func(int)) *eventsHub {
	h := &eventsHub{
		src:  src,
		done: make(chan struct{}),
		subs: make(map[chan watch.InvalidationKind]struct{}),
	}
	if len(onSubscribersChanged) > 0 {
		h.onSubscribersChanged = onSubscribersChanged[0]
	}
	return h
}

func (h *eventsHub) start(onEvent func(watch.InvalidationKind)) {
	h.onEvent = onEvent
	if h.src != nil {
		go h.dispatch()
		return
	}
	close(h.done)
}

func (h *eventsHub) dispatch() {
	defer func() {
		h.mu.Lock()
		for ch := range h.subs {
			close(ch)
			delete(h.subs, ch)
		}
		h.mu.Unlock()
		close(h.done)
	}()
	for k := range h.src {
		if h.onEvent != nil {
			h.onEvent(k)
		}
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

func (h *eventsHub) wait() {
	<-h.done
}

// subscribe registers a subscriber and returns its event channel along with a
// function that detaches it. Closing the source closes every remaining
// subscriber channel so SSE handlers can exit during route retirement or
// process shutdown.
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
	if h.onSubscribersChanged != nil {
		h.onSubscribersChanged(1)
	}
	var once sync.Once
	return ch, func() {
		once.Do(func() {
			h.mu.Lock()
			delete(h.subs, ch)
			h.mu.Unlock()
			if h.onSubscribersChanged != nil {
				h.onSubscribersChanged(-1)
			}
		})
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
