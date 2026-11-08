package app

import (
	"context"

	"github.com/roie/gitna/internal/protocol"
)

func (a *repoAdapter) IndexBaseline(ctx context.Context, path string, budget ...int64) (protocol.EditorBaseline, error) {
	return a.baselines.Read(ctx, a.current(), a.runner, path, budget...)
}
