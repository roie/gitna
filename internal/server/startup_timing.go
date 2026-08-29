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
func RecordStartupTiming(ctx context.Context, name string, duration time.Duration, description string) {
	timings, _ := ctx.Value(startupTimingKey{}).(*startupTimings)
	if timings == nil {
		return
	}
	name = strings.Map(func(char rune) rune {
		if char >= 'a' && char <= 'z' || char >= '0' && char <= '9' || char == '-' {
			return char
		}
		return '-'
	}, strings.ToLower(name))
	entry := fmt.Sprintf("%s;dur=%.2f", name, float64(duration.Microseconds())/1000)
	if description != "" {
		entry += fmt.Sprintf(";desc=%q", strings.ReplaceAll(description, `"`, `'`))
	}
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
