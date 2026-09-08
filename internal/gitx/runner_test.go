package gitx

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
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
	case "echo-env":
		fmt.Fprint(os.Stdout, os.Getenv("GIT_OPTIONAL_LOCKS"))
	case "echo-routing-env":
		for _, key := range repositoryRoutingEnv {
			fmt.Printf("%s=%s\x00", key, os.Getenv(key))
		}
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
		Exec:        os.Args[0],
		StdoutLimit: 1 << 20,
		StderrLimit: 1 << 20,
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

func TestRunDisablesOptionalGitLocks(t *testing.T) {
	setHelper(t, "echo-env")
	r := helperRunner(t)

	res, err := r.Run(context.Background(), t.TempDir())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got := strings.TrimSpace(string(res.Stdout)); got != "0" {
		t.Fatalf("GIT_OPTIONAL_LOCKS = %q, want 0", got)
	}
}

func TestRunScrubsInheritedRepositoryRoutingEnvironment(t *testing.T) {
	setHelper(t, "echo-routing-env")
	for _, key := range repositoryRoutingEnv {
		t.Setenv(key, "poisoned")
	}
	r := helperRunner(t)

	res, err := r.Run(context.Background(), t.TempDir())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	for _, key := range repositoryRoutingEnv {
		if strings.Contains(string(res.Stdout), key+"=poisoned") {
			t.Fatalf("Run preserved inherited %s: %q", key, res.Stdout)
		}
	}
}

func TestFilterKeyScrubsRoutingVariablesCaseInsensitively(t *testing.T) {
	env := []string{"PATH=/bin", "git_dir=poisoned", "Git_Work_Tree=poisoned"}
	env = filterKey(env, "GIT_DIR")
	env = filterKey(env, "GIT_WORK_TREE")
	if got := strings.Join(env, "\n"); got != "PATH=/bin" {
		t.Fatalf("filtered environment = %q, want PATH only", got)
	}

	overridden := envWith([]string{"git_index_file=poisoned"}, "GIT_INDEX_FILE=intentional")
	if len(overridden) != 1 || overridden[0] != "GIT_INDEX_FILE=intentional" {
		t.Fatalf("explicit override = %q, want one intentional value", overridden)
	}
}

func TestRunNULScrubsInheritedRoutingEnvironmentAndAllowsExplicitOverride(t *testing.T) {
	setHelper(t, "echo-routing-env")
	for _, key := range repositoryRoutingEnv {
		t.Setenv(key, "poisoned")
	}
	r := helperRunner(t)
	r.Env = []string{"GIT_INDEX_FILE=intentional"}

	got := make(map[string]string)
	_, err := r.RunNUL(context.Background(), t.TempDir(), func(record []byte) error {
		key, value, ok := strings.Cut(string(record), "=")
		if !ok {
			t.Fatalf("record = %q, want key=value", record)
		}
		got[key] = value
		return nil
	})
	if err != nil {
		t.Fatalf("RunNUL: %v", err)
	}
	for _, key := range repositoryRoutingEnv {
		want := ""
		if key == "GIT_INDEX_FILE" {
			want = "intentional"
		}
		if got[key] != want {
			t.Fatalf("%s = %q, want %q", key, got[key], want)
		}
	}
}

// runtimeConfigEnvs exercises both formats Git accepts for inherited -c config.
func runtimeConfigEnvs(root string) map[string][]string {
	return map[string][]string{
		"count": {
			"GIT_CONFIG_COUNT=1",
			"GIT_CONFIG_KEY_0=core.worktree",
			"GIT_CONFIG_VALUE_0=" + root,
		},
		"parameters": {
			"GIT_CONFIG_PARAMETERS='core.worktree=" + strings.ReplaceAll(root, "'", "'\\''") + "'",
		},
	}
}

func setRuntimeConfigEnv(t *testing.T, env []string) {
	t.Helper()
	for _, kv := range env {
		key, value, _ := strings.Cut(kv, "=")
		t.Setenv(key, value)
	}
}

func TestExecRunnerIsolatesInheritedRuntimeConfig(t *testing.T) {
	root := initTestRepo(t)
	other := t.TempDir()
	for dir, name := range map[string]string{root: "selected.txt", other: "redirected.txt"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(name), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for channel, env := range runtimeConfigEnvs(other) {
		t.Run(channel, func(t *testing.T) {
			setRuntimeConfigEnv(t, env)
			for _, method := range []string{"Run", "RunInput", "RunNUL"} {
				t.Run(method, func(t *testing.T) {
					for _, tc := range []struct {
						name string
						args []string
						env  []string
						want string
						exit int
					}{
						{name: "selected-files", args: []string{"ls-files", "--others", "--exclude-standard", "--full-name", "-z"}, want: "selected.txt\x00"},
						{name: "inherited-config-removed", args: []string{"config", "--null", "--get", "core.worktree"}, exit: 1},
						{name: "explicit-config-preserved", args: []string{"config", "--null", "--get", "core.worktree"}, env: runtimeConfigEnvs(root)[channel], want: root + "\x00"},
					} {
						t.Run(tc.name, func(t *testing.T) {
							r := &ExecRunner{Env: tc.env}
							args := tc.args
							var res Result
							var err error
							var got string
							switch method {
							case "Run":
								res, err = r.Run(t.Context(), root, args...)
								got = string(res.Stdout)
							case "RunInput":
								res, err = r.RunInput(t.Context(), root, []byte{}, args...)
								got = string(res.Stdout)
							case "RunNUL":
								res, err = r.RunNUL(t.Context(), root, func(record []byte) error {
									got += string(record) + "\x00"
									return nil
								}, args...)
							}
							if err != nil || res.ExitCode != tc.exit || got != tc.want {
								t.Fatalf("output = %q, want %q; exit = %d, want %d; stderr = %q, err = %v", got, tc.want, res.ExitCode, tc.exit, res.Stderr, err)
							}
						})
					}
				})
			}
		})
	}
}

func TestExecRunnerEnvironmentScrubsRuntimeConfigCaseInsensitively(t *testing.T) {
	removed := []string{"git_config_count", "Git_Config_Parameters", "git_config_key_0", "Git_Config_Value_0", "GIT_CONFIG_KEY_99", "GIT_CONFIG_VALUE_99"}
	preserved := []string{"GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "HOME", "GIT_AUTHOR_NAME"}
	for _, key := range append(append([]string{}, removed...), preserved...) {
		t.Setenv(key, "sentinel")
	}
	env := (&ExecRunner{}).environment()
	for _, kv := range env {
		key, _, _ := strings.Cut(kv, "=")
		for _, unwanted := range removed {
			if strings.EqualFold(key, unwanted) {
				t.Errorf("inherited runtime config survived: %s", kv)
			}
		}
	}
	for _, key := range preserved {
		if !contains(env, key+"=sentinel") {
			t.Errorf("ordinary environment variable removed: %s", key)
		}
	}
}

func TestExecRunnerPreservesOrdinaryGitConfig(t *testing.T) {
	root := initTestRepo(t)
	runGit(t, root, "config", "gitna.local", "local-value")
	global := filepath.Join(t.TempDir(), "global.config")
	if err := os.WriteFile(global, []byte("[gitna]\n\tglobal = global-value\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GIT_CONFIG_GLOBAL", global)
	for key, want := range map[string]string{"gitna.local": "local-value", "gitna.global": "global-value", "gitna.command": "command-value"} {
		res, err := (&ExecRunner{}).Run(t.Context(), root, "-c", "gitna.command=command-value", "config", "--get", key)
		if err != nil || res.ExitCode != 0 || strings.TrimSpace(string(res.Stdout)) != want {
			t.Fatalf("config %s: result = %+v, err = %v, want %q", key, res, err, want)
		}
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

func TestRunBoundsInheritedOutputPipes(t *testing.T) {
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("sh is unavailable")
	}
	r := helperRunner(t)
	r.Exec = sh
	r.WaitDelay = 100 * time.Millisecond

	start := time.Now()
	_, err = r.Run(context.Background(), t.TempDir(), "-c", "sleep 5 &")
	if !errors.Is(err, exec.ErrWaitDelay) {
		t.Fatalf("error = %v, want exec.ErrWaitDelay", err)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("Run took %v, want inherited pipe wait bounded", elapsed)
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
