package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/roie/gitna/internal/app"
)

var version = "dev"

type cliOptions struct {
	help    bool
	path    string
	version bool
}

func main() {
	os.Exit(runCLI(os.Args[1:], os.Stdout, os.Stderr, func(path string) error {
		ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
		defer stop()
		return app.Run(ctx, path)
	}))
}

func runCLI(args []string, stdout, stderr io.Writer, run func(string) error) int {
	options, err := parseCLIArgs(args)
	if err != nil {
		fmt.Fprintf(stderr, "gitna: %v\nTry 'gitna --help' for usage.\n", err)
		return 2
	}
	if options.help {
		printUsage(stdout)
		return 0
	}
	if options.version {
		fmt.Fprintln(stdout, version)
		return 0
	}
	if err := run(options.path); err != nil {
		fmt.Fprintf(stderr, "gitna: %v\n", err)
		return 1
	}
	return 0
}

func parseCLIArgs(args []string) (cliOptions, error) {
	options := cliOptions{path: "."}
	paths := make([]string, 0, 1)
	positionalOnly := false

	for _, arg := range args {
		if positionalOnly {
			paths = append(paths, arg)
			continue
		}
		switch arg {
		case "--":
			positionalOnly = true
		case "-h", "--help", "help":
			options.help = true
		case "-v", "--version", "-version":
			options.version = true
		default:
			if strings.HasPrefix(arg, "-") {
				return cliOptions{}, fmt.Errorf("unknown option %q", arg)
			}
			paths = append(paths, arg)
		}
	}

	if options.help || options.version {
		return options, nil
	}
	if len(paths) > 1 {
		return cliOptions{}, fmt.Errorf("expected at most one repository path, got %d", len(paths))
	}
	if len(paths) == 1 {
		options.path = paths[0]
	}
	return options, nil
}

func printUsage(output io.Writer) {
	fmt.Fprint(output, `Gitna — a local Git workbench in your browser.

Usage:
  gitna [options] [repository]

Arguments:
  repository    Path to a Git repository (default: current directory)

Options:
  -h, --help       Show this help
  -v, --version    Print the Gitna version

Examples:
  gitna
  gitna .
  gitna ~/code/project
`)
}
