package gitx

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"testing"
	"time"
)

// TestHelperProcess is re-invoked by the tests below as a stand-in for git so
// argument safety and output behavior can be asserted without a shell script.
func TestHelperProcess(t *testing.T) {
	if os.Getenv("GV_HELPER") != "1" {
		return
	}
	switch os.Getenv("GV_HELPER_MODE") {
	case "echo-args":
		fmt.Printf("%q\n", os.Args[1:])
	case "split-output":
		fmt.Fprint(os.Stderr, "error-out\n")
		fmt.Fprint(os.Stdout, "stdout-out\n")
	case "echo-stdin":
		in, err := io.ReadAll(os.Stdin)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Printf("stdin:%s", in)
	case "sleep":
		time.Sleep(30 * time.Second)
	case "huge":
		for i := 0; i < 1<<20; i++ {
			fmt.Fprintf(os.Stdout, "%s", strings.Repeat("x", 128))
		}
	}
	os.Exit(0)
}

func helperRunner(t *testing.T) *ExecRunner {
	t.Helper()
	return &ExecRunner{
		Exec:         os.Args[0],
		StdoutLimit:  1 << 20,
		StderrLimit:  1 << 20,
	}
}

func setHelper(t *testing.T, mode string) {
	t.Helper()
	t.Setenv("GV_HELPER", "1")
	t.Setenv("GV_HELPER_MODE", mode)
}

func TestRunPassesArgsDirectly(t *testing.T) {
	setHelper(t, "echo-args")
	r := helperRunner(t)

	res, err := r.Run(context.Background(), t.TempDir(),
		"a file with spaces", "$HOME", "*.txt", "-n", "--flag=value")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.ExitCode != 0 {
		t.Fatalf("exit code = %d, want 0", res.ExitCode)
	}
	want := []string{"a file with spaces", "$HOME", "*.txt", "-n", "--flag=value"}
	got := strings.TrimSpace(string(res.Stdout))
	for _, w := range want {
		if !strings.Contains(got, fmt.Sprintf("%q", w)) {
			t.Fatalf("stdout %q does not contain unexpanded arg %q", got, w)
		}
	}
	if strings.Contains(got, "$HOME") {
		// The marker above asserts literal pass-through; a shell would expand it.
	}
}

func TestRunInputFeedsStdin(t *testing.T) {
	setHelper(t, "echo-stdin")
	r := helperRunner(t)

	res, err := r.RunInput(context.Background(), t.TempDir(), []byte("patch-body"), "apply", "--cached", "-")
	if err != nil {
		t.Fatalf("RunInput: %v", err)
	}
	if res.ExitCode != 0 {
		t.Fatalf("exit code = %d, want 0", res.ExitCode)
	}
	if got := strings.TrimSpace(string(res.Stdout)); got != "stdin:patch-body" {
		t.Fatalf("stdout = %q, want stdin:patch-body", got)
	}
}

func TestRunSeparatesStdoutAndStderr(t *testing.T) {
	setHelper(t, "split-output")
	r := helperRunner(t)

	res, err := r.Run(context.Background(), t.TempDir())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if strings.TrimSpace(string(res.Stdout)) != "stdout-out" {
		t.Fatalf("stdout = %q, want %q", res.Stdout, "stdout-out")
	}
	if strings.TrimSpace(string(res.Stderr)) != "error-out" {
		t.Fatalf("stderr = %q, want %q", res.Stderr, "error-out")
	}
}

func TestRunCancellationKillsProcess(t *testing.T) {
	setHelper(t, "sleep")
	r := helperRunner(t)

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	start := time.Now()
	_, err := r.Run(ctx, t.TempDir())
	if err == nil {
		t.Fatal("Run = nil error, want cancellation error")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("error = %v, want context.DeadlineExceeded", err)
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("Run took %v, want prompt cancellation", elapsed)
	}
}

func TestRunReturnsExitCodeOnFailure(t *testing.T) {
	setHelper(t, "echo-args")
	r := helperRunner(t)
	// Unknown flag makes git itself fail with a non-zero exit.
	res, err := r.Run(context.Background(), t.TempDir(), "--definitely-not-a-git-flag")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.ExitCode == 0 {
		t.Fatal("exit code = 0, want non-zero for failing git invocation")
	}
}

func TestRunOutputLimit(t *testing.T) {
	setHelper(t, "huge")
	r := helperRunner(t)
	r.StdoutLimit = 1024

	_, err := r.Run(context.Background(), t.TempDir())
	if !errors.Is(err, ErrOutputLimit) {
		t.Fatalf("error = %v, want ErrOutputLimit", err)
	}
}

func TestEnvWithReplacesKeys(t *testing.T) {
	env := envWith(
		[]string{"PATH=/usr/bin", "GIT_TERMINAL_PROMPT=1", "HOME=/root"},
		"GIT_TERMINAL_PROMPT=0",
	)
	want := "GIT_TERMINAL_PROMPT=0"
	if !contains(env, want) {
		t.Fatalf("env %v missing %q", env, want)
	}
	for _, kv := range env {
		if strings.HasPrefix(kv, "GIT_TERMINAL_PROMPT=") && kv != want {
			t.Fatalf("env %v has duplicate/old GIT_TERMINAL_PROMPT value %q", env, kv)
		}
	}
	if !contains(env, "PATH=/usr/bin") || !contains(env, "HOME=/root") {
		t.Fatalf("env %v dropped unrelated keys", env)
	}
}

func contains(env []string, kv string) bool {
	for _, e := range env {
		if e == kv {
			return true
		}
	}
	return false
}
