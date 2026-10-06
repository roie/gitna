package app

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/roie/gitna/internal/gitx"
	"github.com/roie/gitna/internal/protocol"
)

func TestLongContentSearchMatchesRegularExpressionSemantics(t *testing.T) {
	line := strings.Repeat("x ", 35000) + "😀 K ſ NeedLE needles needle café"
	file, err := os.CreateTemp(t.TempDir(), "text")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if _, err := io.WriteString(file, line); err != nil {
		t.Fatal(err)
	}
	for _, pattern := range []string{`needle`, `(?i)needle`, `(?i)k|s`, `^x`, `(?m)^x`, `\Ax|\z`, `café$`, `\bneedle\b`, `(need)(le)`, `x*`, `x|`, `(?:)`, `x.*needle`, `x.+?x`, `x$|missing`} {
		for _, wholeWord := range []bool{false, true} {
			t.Run(pattern+"/"+map[bool]string{false: "any", true: "word"}[wholeWord], func(t *testing.T) {
				expression := regexp.MustCompile(pattern)
				continuation := regexp.MustCompile(`(?s:\A.)(?s:.*?)(` + pattern + `)`)
				const limit = 12
				var want []protocol.ContentSearchMatch
				for _, indices := range expression.FindAllStringIndex(line, -1) {
					if wholeWord && !contentSearchWordBoundary(line, indices[0], indices[1]) {
						continue
					}
					want = append(want, contentSearchExcerpt(line, 7, indices[0], indices[1]))
					if len(want) == limit {
						break
					}
				}
				got, valid, err := scanLongContentSearchLine(t.Context(), file, 0, int64(len(line)), 7, limit, expression, continuation, wholeWord)
				if err != nil || !valid || !reflect.DeepEqual(got, want) {
					t.Fatalf("got %#v, valid %v, err %v; want %#v", got, valid, err, want)
				}
			})
		}
	}
}

func TestContentSearchRejectsBinaryLongLines(t *testing.T) {
	for _, invalid := range []string{"\x00", "\xff"} {
		t.Run(invalid, func(t *testing.T) {
			root := t.TempDir()
			if err := os.WriteFile(filepath.Join(root, "text.txt"), []byte("needle\n"+strings.Repeat("x", 70000)+" needle"+invalid), 0o644); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			adapter := &repoAdapter{ctx: ctx, repo: gitx.Repository{Root: root}, queue: gitx.NewMutationQueue()}
			waitForFolderSearch(t, adapter, "", nil, 100)
			result, err := adapter.SearchContent(t.Context(), "needle", false, false, false, false, "", "", 100)
			if err != nil || len(result.Results) != 0 {
				t.Fatalf("binary text accepted: %#v, %v", result, err)
			}
		})
	}
}

func TestContentSearchCancelsDuringLongLine(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "long.txt"), []byte(strings.Repeat("x", 32<<20)), 0o644); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	adapter := &repoAdapter{ctx: ctx, repo: gitx.Repository{Root: root}, queue: gitx.NewMutationQueue()}
	waitForFolderSearch(t, adapter, "", nil, 100)
	search, stop := context.WithCancel(t.Context())
	defer stop()
	timer := time.AfterFunc(10*time.Millisecond, stop)
	defer timer.Stop()
	started := time.Now()
	_, err := adapter.SearchContent(search, `x.*absent`, true, false, true, false, "", "", 100)
	if !errors.Is(err, context.Canceled) || time.Since(started) > time.Second {
		t.Fatalf("cancellation took %s, error %v", time.Since(started), err)
	}
}

func TestContentSearchRuneReaderCancelsBufferedInput(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "text")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if _, err := io.WriteString(file, strings.Repeat("x", 32768)); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	reader := newContentSearchRuneReader(ctx, file, 0, 32768)
	if _, _, err := reader.ReadRune(); err != nil {
		t.Fatal(err)
	}
	cancel()
	for range 1024 {
		if _, _, err := reader.ReadRune(); errors.Is(err, context.Canceled) {
			return
		}
	}
	t.Fatal("buffered text delayed cancellation beyond 1024 runes")
}

func BenchmarkContentSearchLongLine(b *testing.B) {
	for _, size := range []int{1 << 20, 8 << 20} {
		b.Run(map[int]string{1 << 20: "1MiB", 8 << 20: "8MiB"}[size], func(b *testing.B) {
			file, err := os.CreateTemp(b.TempDir(), "text")
			if err != nil {
				b.Fatal(err)
			}
			defer file.Close()
			if _, err := io.WriteString(file, strings.Repeat("x", size)+" needle"); err != nil {
				b.Fatal(err)
			}
			expression := regexp.MustCompile("needle")
			continuation := regexp.MustCompile(`(?s:\A.)(?s:.*?)(needle)`)
			b.ReportAllocs()
			b.SetBytes(int64(size))
			b.ResetTimer()
			for range b.N {
				matches, valid, err := scanLongContentSearchLine(b.Context(), file, 0, int64(size+7), 1, 100, expression, continuation, false)
				if err != nil || !valid || len(matches) != 1 {
					b.Fatalf("%#v %v %v", matches, valid, err)
				}
			}
		})
	}
}
