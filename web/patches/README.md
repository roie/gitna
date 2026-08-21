# Pierre Trees package patch

`@pierre/trees@1.0.0-beta.6` is Apache-2.0 software from Pierre Computer
Company. Gitna applies `@pierre__trees@1.0.0-beta.6.patch` to the package
published from the pinned Pierre donor commit
`59ec35ffac97abccef4c69f8d58d3747cbfbc6cb`.

Gitna's modification adds the generic `FileTreeOptions.renderRowActions`
public API. Pierre resolves and renders semantic action buttons inside its own
row renderer, including hover/focus styling; Pierre continues to own Tree DOM,
selection, focus, search, sticky rows, and virtualization. Gitna only supplies
typed action descriptions and callbacks.

The patch is retained as the reproducible distribution artifact rather than a
parallel or copied Tree implementation. See `THIRD_PARTY_NOTICES.md` for the
license and attribution record.
