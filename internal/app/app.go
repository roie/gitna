// Package app wires the local workbench process together: loopback server,
// browser launch, and (in later tasks) repository discovery and sessions.
package app

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/roie/gitna/internal/browser"
	"github.com/roie/gitna/internal/gitx"
	"github.com/roie/gitna/internal/protocol"
	"github.com/roie/gitna/internal/server"
	"github.com/roie/gitna/internal/session"
	"github.com/roie/gitna/internal/webui"
)

// repoAdapter bridges the git-backed repository to the server's Repo interface.
type repoAdapter struct {
	runner *gitx.ExecRunner
	repo   gitx.Repository
}

func (a repoAdapter) Snapshot(ctx context.Context) (protocol.RepoSnapshot, error) {
	return a.repo.Status(ctx, a.runner)
}

// Run starts the workbench session for path and blocks until ctx is cancelled
// or the server fails. path must be inside a Git repository; the session binds
// to a loopback-only OS-assigned port.
func Run(ctx context.Context, path string) error {
	runner := &gitx.ExecRunner{}
	repo, err := gitx.Discover(ctx, runner, path)
	if err != nil {
		return fmt.Errorf("app: %w", err)
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("app: listen: %w", err)
	}

	tcpAddr, ok := ln.Addr().(*net.TCPAddr)
	if !ok {
		return fmt.Errorf("app: unexpected listener address %T", ln.Addr())
	}

	token, err := session.NewToken()
	if err != nil {
		return fmt.Errorf("app: %w", err)
	}
	host := fmt.Sprintf("127.0.0.1:%d", tcpAddr.Port)

	staticFS, err := webui.Assets()
	if err != nil {
		return fmt.Errorf("app: load embedded assets: %w", err)
	}

	srv, err := server.New(staticFS, server.Options{
		Token: token,
		Host:  host,
		Repo:  repoAdapter{runner: runner, repo: repo},
	})
	if err != nil {
		return fmt.Errorf("app: create server: %w", err)
	}

	url := fmt.Sprintf("http://%s/s/%s/", host, token)
	fmt.Printf("gitna: %s\n", repo.Root)
	fmt.Printf("gitna: serving %s\n", url)

	if err := browser.Open(url); err != nil {
		fmt.Fprintf(os.Stderr, "gitna: could not open browser: %v\n", err)
	}

	httpSrv := &http.Server{Handler: srv.Handler()}

	errCh := make(chan error, 1)
	go func() { errCh <- httpSrv.Serve(ln) }()

	select {
	case err := <-errCh:
		return fmt.Errorf("app: server: %w", err)
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return httpSrv.Shutdown(shutdownCtx)
	}
}
