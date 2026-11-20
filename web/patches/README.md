# Pierre package patches

Only the active patches listed in `web/pnpm-workspace.yaml` belong here.
Previous patch versions remain available in Git history.

## Diffs 1.7.0-beta.4

`@pierre__diffs@1.7.0-beta.4.patch` carries Gitna's preview body slot,
invalid-regex feedback, bounded large-file editing, and plain-text edit
refresh. The patch also makes the gutter **+** follow the hovered line while no
gutter or line selection is in progress, and start a comment draft on the
pressed line, so a draft can move to another line.

The preview body slot lets Gitna render its PDF and media previews inside
Pierre's code view. Invalid search patterns mark the find input, describe the
error, and announce "Invalid regex" through the status element. Large edit
sessions keep file contents and lines lazy, render only the requested window,
and do no whole-document work per keystroke. Plain-text edits rewrite only the rows whose HTML changed and
update the visible lines without full-document
background tokenization.

## Trees 1.0.0

`@pierre/trees@1.0.0` is Apache-2.0 software from Pierre Computer Company.
Gitna applies `@pierre__trees@1.0.0.patch` to the package whose source is at
Pierre tag `diffs-v1.7.0-beta.4` (commit
`8b12bdd75d723ac5b83cb9efe11c8ddb818bf462`).

Gitna's modification adds the generic `FileTreeOptions.renderRowActions`
public API. Pierre resolves and renders semantic action buttons inside its own
row renderer, including hover/focus styling; Pierre continues to own Tree DOM,
selection, focus, search, sticky rows, and virtualization. Gitna only supplies
typed action descriptions and callbacks.

The patch also loads folder children on demand, renders tree rows as `<div>`
elements, and makes built-in middle truncation split text only at Unicode
grapheme boundaries with `Intl.Segmenter`. It preserves emoji sequences and
combining marks instead of dividing them between separate DOM elements.

The patch is retained as the reproducible distribution artifact rather than a
parallel or copied Tree implementation. See `THIRD_PARTY_NOTICES.md` for the
license and attribution record.
