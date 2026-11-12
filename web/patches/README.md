# Pierre package patches

Only the active patches listed in `web/pnpm-workspace.yaml` belong here.
Previous patch versions remain available in Git history.

## Diffs 1.6.4

`@pierre__diffs@1.6.4.patch` carries Gitna's raster preview slots, editor theme
updates, invalid-regex feedback, and bounded large-file rendering. It also
refreshes plain-text edits without full-document background tokenization.
While no gutter or line selection is in progress, the gutter **+** follows the
hovered line instead of staying on an existing selection, and pressing it on a
line outside that selection starts there, so a comment draft can be moved to
another line.

## Trees 1.0.0-beta.6

`@pierre/trees@1.0.0-beta.6` is Apache-2.0 software from Pierre Computer
Company. Gitna applies `@pierre__trees@1.0.0-beta.6.patch` to the package
published from the pinned Pierre donor commit
`59ec35ffac97abccef4c69f8d58d3747cbfbc6cb`.

Gitna's modification adds the generic `FileTreeOptions.renderRowActions`
public API. Pierre resolves and renders semantic action buttons inside its own
row renderer, including hover/focus styling; Pierre continues to own Tree DOM,
selection, focus, search, sticky rows, and virtualization. Gitna only supplies
typed action descriptions and callbacks.

The patch also makes built-in middle truncation split text only at Unicode
grapheme boundaries with `Intl.Segmenter`. It preserves emoji sequences and
combining marks instead of dividing them between separate DOM elements.

The patch is retained as the reproducible distribution artifact rather than a
parallel or copied Tree implementation. See `THIRD_PARTY_NOTICES.md` for the
license and attribution record.
