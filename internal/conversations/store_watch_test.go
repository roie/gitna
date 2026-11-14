package conversations

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"testing"
	"time"
)

func TestWaitPendingAcrossProcesses(t *testing.T) {
	if dir := os.Getenv("GITNA_TEST_WAIT_STORE"); dir != "" {
		waitPendingInProcess(t, dir)
		return
	}

	dir := t.TempDir()
	writer, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	reader := joinAgent(t, writer)
	other := joinAgent(t, writer)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestWaitPendingAcrossProcesses$")
	cmd.Env = append(os.Environ(), "GITNA_TEST_WAIT_STORE="+dir, "GITNA_TEST_WAIT_PARTICIPANT="+reader.ID)
	cmd.Stderr = os.Stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	output := bufio.NewReader(stdout)
	ready, err := output.ReadString('\n')
	if err != nil || ready != "waiting\n" {
		cancel()
		cmd.Wait()
		t.Fatalf("reader readiness = %q, %v", ready, err)
	}
	for _, message := range []struct {
		recipient Participant
		body      string
	}{{other, "for someone else"}, {reader, "ping"}} {
		if _, err := writer.Create(human, "", anchorAt("a", 1, 1, "x"), message.body, []string{message.recipient.ID}); err != nil {
			cancel()
			cmd.Wait()
			t.Fatal(err)
		}
	}
	result, readErr := io.ReadAll(output)
	if err := cmd.Wait(); err != nil || readErr != nil {
		t.Fatalf("waiting process failed: %v, %v\n%s", err, readErr, result)
	}
	if pending, _, err := writer.Pending(reader.ID); err != nil || len(pending) != 0 {
		t.Fatalf("acknowledged pending = %+v, %v", pending, err)
	}
	if pending, _, err := writer.Pending(other.ID); err != nil || len(pending) != 1 {
		t.Fatalf("other agent pending = %+v, %v", pending, err)
	}
}

func waitPendingInProcess(t *testing.T, dir string) {
	t.Helper()
	store, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	ready := false
	id := os.Getenv("GITNA_TEST_WAIT_PARTICIPANT")
	pending, _, err := store.WaitPending(ctx, id, func(pending []Pending) []Pending {
		if !ready {
			fmt.Println("waiting")
			ready = true
		}
		return pending
	})
	if err != nil || len(pending) != 1 || pending[0].Message.Body != "ping" {
		t.Fatalf("cross-process pending = %+v, %v", pending, err)
	}
	if _, err := store.Ack(id, pending[0].Message.Seq, nil); err != nil {
		t.Fatal(err)
	}
}
