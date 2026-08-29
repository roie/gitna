package watch

import (
	"os"
	"strconv"
	"strings"
	"sync"
)

var ordinaryWatchBudget = struct {
	sync.Mutex
	used int
	max  int
}{max: ordinaryWatchBudgetLimit()}

func ordinaryWatchBudgetLimit() int {
	const fallback = 8_192
	data, err := os.ReadFile("/proc/sys/fs/inotify/max_user_watches")
	if err != nil {
		return fallback
	}
	value, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		return fallback
	}
	limit := value / 16
	if limit < 512 {
		return 512
	}
	if limit > fallback {
		return fallback
	}
	return limit
}

func acquireOrdinaryWatchBudget() bool {
	ordinaryWatchBudget.Lock()
	defer ordinaryWatchBudget.Unlock()
	if ordinaryWatchBudget.used >= ordinaryWatchBudget.max {
		return false
	}
	ordinaryWatchBudget.used++
	return true
}

func releaseOrdinaryWatchBudget(count int) {
	ordinaryWatchBudget.Lock()
	ordinaryWatchBudget.used -= count
	if ordinaryWatchBudget.used < 0 {
		ordinaryWatchBudget.used = 0
	}
	ordinaryWatchBudget.Unlock()
}
