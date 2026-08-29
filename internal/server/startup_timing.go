package server

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
)

const startupTraceEnvironment = "GITNA_TRACE_STARTUP"

var startupTimingPhases = map[string]struct{}{
	"activation-wait":        {},
	"folder-resolve":         {},
	"folder-resolve-git":     {},
	"folder-resolve-symlink": {},
	"open-total":             {},
	"route-lookup":           {},
	"route-reserve":          {},
}

type startupTimingKey struct{}

type startupTimings struct {
	mu      sync.Mutex
	entries []string
}

// StartupTraceEnabled reports whether opt-in local startup diagnostics are enabled.
func StartupTraceEnabled() bool { return os.Getenv(startupTraceEnvironment) == "1" }

func withStartupTimings(ctx context.Context) context.Context {
	if !StartupTraceEnabled() {
		return ctx
	}
	return context.WithValue(ctx, startupTimingKey{}, &startupTimings{})
}

// RecordStartupTiming adds one duration to the current open-folder request.
// It is a no-op unless GITNA_TRACE_STARTUP=1 and the server installed a recorder.
// Only allowlisted phase names and durations are retained; paths and errors are never recorded.
func RecordStartupTiming(ctx context.Context, name string, duration time.Duration) {
	timings, _ := ctx.Value(startupTimingKey{}).(*startupTimings)
	if timings == nil {
		return
	}
	name = strings.ToLower(name)
	if _, allowed := startupTimingPhases[name]; !allowed {
		return
	}
	entry := fmt.Sprintf("%s;dur=%.2f", name, float64(duration.Microseconds())/1000)
	timings.mu.Lock()
	timings.entries = append(timings.entries, entry)
	timings.mu.Unlock()
}

func startupServerTiming(ctx context.Context) string {
	timings, _ := ctx.Value(startupTimingKey{}).(*startupTimings)
	if timings == nil {
		return ""
	}
	timings.mu.Lock()
	defer timings.mu.Unlock()
	return strings.Join(timings.entries, ", ")
}
