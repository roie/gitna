package browser

import (
	"errors"
	"reflect"
	"testing"
)

func TestOpenCommandFor(t *testing.T) {
	url := "http://127.0.0.1:4321/g/token/folder/?name=space%20%E2%9C%93"
	tests := []struct {
		name string
		goos string
		wsl  bool
		want []string
	}{
		{name: "linux", goos: "linux", want: []string{"xdg-open", url}},
		{name: "WSL", goos: "linux", wsl: true, want: []string{"cmd.exe", "/c", "start", "", url}},
		{name: "Windows", goos: "windows", want: []string{"rundll32", "url.dll,FileProtocolHandler", url}},
		{name: "Darwin", goos: "darwin", want: []string{"/usr/bin/open", url}},
		{name: "Darwin ignores leaked WSL state", goos: "darwin", wsl: true, want: []string{"/usr/bin/open", url}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := openCommandFor(test.goos, test.wsl, url)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, test.want) {
				t.Fatalf("openCommandFor() = %#v, want %#v", got, test.want)
			}
		})
	}
	if _, err := openCommandFor("plan9", false, url); err == nil {
		t.Fatal("openCommandFor() accepted unsupported platform")
	}
}

func TestOpenForStartsPlannedCommand(t *testing.T) {
	original := startCommand
	t.Cleanup(func() { startCommand = original })
	var gotName string
	var gotArgs []string
	startCommand = func(name string, args ...string) error {
		gotName = name
		gotArgs = append([]string(nil), args...)
		return nil
	}
	url := "http://127.0.0.1:4321/g/token/folder/"
	if err := openFor("darwin", false, url); err != nil {
		t.Fatal(err)
	}
	if gotName != "/usr/bin/open" || !reflect.DeepEqual(gotArgs, []string{url}) {
		t.Fatalf("started %q %#v", gotName, gotArgs)
	}

	wantErr := errors.New("start failed")
	startCommand = func(string, ...string) error { return wantErr }
	if err := openFor("darwin", false, url); !errors.Is(err, wantErr) {
		t.Fatalf("openFor() error = %v, want %v", err, wantErr)
	}
}

func TestRevealCommandFor(t *testing.T) {
	path := "/Users/Roie/My Folder/✓-notes.txt"
	tests := []struct {
		name        string
		goos        string
		isDirectory bool
		want        []string
	}{
		{name: "Linux", goos: "linux", want: []string{"xdg-open", path}},
		{name: "Windows", goos: "windows", want: []string{"explorer.exe", path}},
		{name: "Darwin folder", goos: "darwin", isDirectory: true, want: []string{"/usr/bin/open", path}},
		{name: "Darwin file", goos: "darwin", want: []string{"/usr/bin/open", "-R", path}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := revealCommandFor(test.goos, path, test.isDirectory)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, test.want) {
				t.Fatalf("revealCommandFor() = %#v, want %#v", got, test.want)
			}
		})
	}
	if _, err := revealCommandFor("plan9", path, false); err == nil {
		t.Fatal("revealCommandFor() accepted unsupported platform")
	}
}

func TestRevealForStartsDarwinCommandWithoutShell(t *testing.T) {
	original := startCommand
	t.Cleanup(func() { startCommand = original })
	var gotName string
	var gotArgs []string
	startCommand = func(name string, args ...string) error {
		gotName = name
		gotArgs = append([]string(nil), args...)
		return nil
	}
	path := "/Users/Roie/My Folder/✓-notes.txt"
	if err := revealFor("darwin", false, path, false); err != nil {
		t.Fatal(err)
	}
	if gotName != "/usr/bin/open" || !reflect.DeepEqual(gotArgs, []string{"-R", path}) {
		t.Fatalf("started %q %#v", gotName, gotArgs)
	}
}

func TestRevealForConvertsWSLPathWithoutShell(t *testing.T) {
	originalStart := startCommand
	originalOutput := commandOutput
	t.Cleanup(func() {
		startCommand = originalStart
		commandOutput = originalOutput
	})

	commandOutput = func(name string, args ...string) ([]byte, error) {
		if name != "wslpath" || !reflect.DeepEqual(args, []string{"-w", "/home/roie/My Folder"}) {
			t.Fatalf("output command = %q %#v", name, args)
		}
		return []byte("C:\\Users\\Roie\\My Folder\r\n"), nil
	}
	var gotName string
	var gotArgs []string
	startCommand = func(name string, args ...string) error {
		gotName = name
		gotArgs = append([]string(nil), args...)
		return nil
	}
	if err := revealFor("linux", true, "/home/roie/My Folder", true); err != nil {
		t.Fatal(err)
	}
	if gotName != "explorer.exe" || !reflect.DeepEqual(gotArgs, []string{"C:\\Users\\Roie\\My Folder"}) {
		t.Fatalf("started %q %#v", gotName, gotArgs)
	}
}
