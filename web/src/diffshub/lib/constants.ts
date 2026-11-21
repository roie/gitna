import type { CodeViewLayout } from '@pierre/diffs';

export const CODE_VIEW_LAYOUT: CodeViewLayout = {
  paddingTop: 0,
  gap: 1,
  paddingBottom: 0,
};

export const CODE_VIEW_CUSTOM_CSS = `
::highlight(gitna-search) {
  background-color: var(--gitna-search-match-bg);
  color: var(--gitna-search-match-fg);
}
::highlight(gitna-search-active) {
  background-color: var(--gitna-search-active-match-bg);
  color: var(--gitna-search-match-fg);
  text-decoration: underline;
}

[data-diffs-header] {
  container-type: scroll-state;
  container-name: sticky-header;
}

/* Non-text bodies have unknown line counts, not zero changed lines. */
[data-diffs-header]:has(~ [data-custom-body]:not([hidden])) [data-additions-count],
[data-diffs-header]:has(~ [data-custom-body]:not([hidden])) [data-deletions-count] {
  display: none;
}

[data-editor-widget] {
  box-shadow: var(--gitna-overlay-shadow, none) !important;
}

[data-file][data-disable-line-numbers] [data-gutter] > [data-column-number] {
  min-inline-size: 7px;
}
[data-file] [data-gitna-change]::before {
  content: '';
  position: absolute;
  inset-inline-start: 0;
  inset-block: 0;
  inline-size: 3px;
  background: var(--diffs-addition-base);
  pointer-events: none;
}
[data-file] [data-gitna-change='modified']::before {
  background: var(--diffs-modified-base);
}
[data-file] [data-gitna-deletion]::after {
  content: '';
  position: absolute;
  inset-inline-start: 0;
  inset-block-end: 0;
  inline-size: 7px;
  block-size: 6px;
  background: var(--diffs-deletion-base);
  clip-path: polygon(0 0, 100% 50%, 0 100%);
  pointer-events: none;
}
[data-file] [data-gitna-deletion='before']::after {
  inset-block-start: 0;
  inset-block-end: auto;
}

@container sticky-header scroll-state(stuck: top) {
  [data-diffs-header]::after {
    position: absolute;
    bottom: -1px;
    left: 0;
    width: 100%;
    height: 1px;
    content: '';
    background-color: var(--diffshub-annotation-border);
  }
}
`;

export const CODE_VIEW_FILE_TREE_ITEM_HEIGHT = 24;
// The open Pierre search container renders at 43px and keeps the donor's 12px
// block-end margin. Stacked Source Control Trees reserve exactly that chrome so
// search does not create an internal scrollbar or clip its final result row.
export const CODE_VIEW_FILE_TREE_SEARCH_OPEN_HEIGHT = 55;
export const CODE_VIEW_BATCH_COUNT = 25;
export const CODE_VIEW_BATCH_COUNT_MAX = 96;

export function getInitialBatchSize(): number {
  const viewportHeight = getViewportHeight();
  if (viewportHeight == null) {
    return CODE_VIEW_BATCH_COUNT;
  }

  return Math.min(
    CODE_VIEW_BATCH_COUNT_MAX,
    Math.max(
      CODE_VIEW_BATCH_COUNT,
      Math.ceil(viewportHeight / CODE_VIEW_FILE_TREE_ITEM_HEIGHT)
    )
  );
}

function getViewportHeight(): number | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  return Number.isFinite(viewportHeight) && viewportHeight > 0
    ? viewportHeight
    : null;
}
