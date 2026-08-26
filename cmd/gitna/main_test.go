package main

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

func TestRunCLIHelp(t *testing.T) {
	var stdout, stderr bytes.Buffer
	called := false

	code := runCLI([]string{"--help"}, &stdout, &stderr, func(string) error {
		called = true
		return nil
	})

	if code != 0 || called || stderr.Len() != 0 {
		t.Fatalf("runCLI help: code=%d called=%v stderr=%q", code, called, stderr.String())
	}
	for _, text := range []string{"Gitna", "Usage:", "Arguments:", "Options:", "Examples:"} {
		if !strings.Contains(stdout.String(), text) {
			t.Errorf("help missing %q:\n%s", text, stdout.String())
		}
	}
}

func TestRunCLIVersionAliases(t *testing.T) {
	for _, arg := range []string{"-v", "--version", "-version"} {
		t.Run(arg, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			code := runCLI([]string{arg}, &stdout, &stderr, func(string) error {
				t.Fatal("version must not start the app")
				return nil
			})
			if code != 0 || stdout.String() != version+"\n" || stderr.Len() != 0 {
				t.Fatalf("runCLI(%q): code=%d stdout=%q stderr=%q", arg, code, stdout.String(), stderr.String())
			}
		})
	}
}

func TestRunCLIRepositoryPath(t *testing.T) {
	tests := []struct {
		args []string
		want string
	}{
		{want: "."},
		{args: []string{"/tmp/project"}, want: "/tmp/project"},
		{args: []string{"--", "-project"}, want: "-project"},
	}
	for _, test := range tests {
		t.Run(test.want, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			var path string
			code := runCLI(test.args, &stdout, &stderr, func(value string) error {
				path = value
				return nil
			})
			if code != 0 || path != test.want || stdout.Len() != 0 || stderr.Len() != 0 {
				t.Fatalf("runCLI: code=%d path=%q stdout=%q stderr=%q", code, path, stdout.String(), stderr.String())
			}
		})
	}
}

func TestRunCLIUsageErrors(t *testing.T) {
	for _, args := range [][]string{{"--unknown"}, {"one", "two"}} {
		var stdout, stderr bytes.Buffer
		code := runCLI(args, &stdout, &stderr, func(string) error {
			t.Fatal("invalid arguments must not start the app")
			return nil
		})
		if code != 2 || stdout.Len() != 0 || !strings.Contains(stderr.String(), "gitna:") || !strings.Contains(stderr.String(), "gitna --help") {
			t.Fatalf("runCLI(%q): code=%d stdout=%q stderr=%q", args, code, stdout.String(), stderr.String())
		}
	}
}

func TestRunCLIAppError(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := runCLI(nil, &stdout, &stderr, func(string) error { return errors.New("cannot start") })
	if code != 1 || stdout.Len() != 0 || stderr.String() != "gitna: cannot start\n" {
		t.Fatalf("runCLI: code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
}
