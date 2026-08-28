import type { CodeViewLayout } from '@pierre/diffs';
import type { FileTreeOptions } from '@pierre/trees';

export const CODE_VIEW_LAYOUT: CodeViewLayout = {
  paddingTop: 0,
  gap: 1,
  paddingBottom: 0,
};

export const CODE_VIEW_CUSTOM_CSS = `
[data-diffs-header] {
  container-type: scroll-state;
  container-name: sticky-header;
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

// Hide the built-in search input until the user opts into search via the
// sidebar toggle. The trees library always mounts the input when
// `search: true`, but reflects open/closed state on the container's
// `data-open` attribute -- we collapse it when closed so it doesn't take up
// vertical space above the tree.
const HIDDEN_SEARCH_UNSAFE_CSS = `
  [data-file-tree-search-container][data-open='false'] {
    display: none;
  }
  [data-file-tree-search-container] {
    padding-bottom: 12px;
    margin-bottom: 12px;
    margin-right: 4px;
    border-bottom: 1px solid var(--color-border);
    padding-inline-start: 1px;
    padding-inline-end: 5px;
  }

  [data-file-tree-sticky-overlay-content] {
    box-shadow: 0 2px 3px -4px rgb(0 0 0 / 1);

    [data-item-section="spacing"] {
      opacity: 0.5;
    }

    > [data-file-tree-sticky-path]:last-of-type {
      border-bottom-left-radius: 0;
      border-bottom-right-radius: 0;

      [data-item-section="spacing"] {
        margin-bottom: 4px;
      }
    }
  }

  @media (prefers-color-scheme: dark) {
    [data-file-tree-sticky-overlay-content] {
      box-shadow: 0 3px 3px -3px rgb(0 0 0 / 80%);

      [data-item-section="spacing"] {
        opacity: 0.6;
      }
    }
  }
`;

/** In `@layer unsafe` so it overrides core tree `padding-inline` without host vars. */
const SIDEBAR_VIRTUALIZED_SCROLL_UNSAFE_CSS = `
  [data-file-tree-virtualized-scroll="true"] {
    padding-inline-start: 0;
    padding-inline-end: 2px;
    margin-inline-end: 2px;
  }

  @media (width <= 767px) {
    [data-file-tree-search-container="true"],
    [data-file-tree-virtualized-scroll="true"] {
      padding-inline-start: 14px;
    }

    [data-file-tree-search-container="true"] {
      margin-right: 0;
      padding-inline-end: 14px;
    }

    [data-file-tree-virtualized-scroll="true"] {
      padding-inline-end: max(0px, calc(14px - var(--trees-scrollbar-gutter)));
    }
  }
`;

// In this view everything is assumed to be changing, so the folder dot that
// signals "contains a git change" is superfluous and is hidden globally.
const SUPPRESS_FOLDER_DOT_UNSAFE_CSS = `
  [data-item-contains-git-change='true'] > [data-item-section='git'] {
    display: none;
  }
`;

// Folders get higher contrast and medium weight to stand out from regular file
// entries, which use the default muted tree fg color.
const FOLDER_LABEL_UNSAFE_CSS = `
  [data-item-type='folder'] {
    color: color-mix(in lab, light-dark(#000, #fff) 25%, var(--trees-fg));
    font-weight: 500;
  }
`;

const FILE_TREE_ACTION_SPRITE_SHEET = `
<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="display:none">
  <symbol id="gitna-action-stage" viewBox="0 0 16 16"><path d="M7 3h2v4h4v2H9v4H7V9H3V7h4z" /></symbol>
  <symbol id="gitna-action-unstage" viewBox="0 0 16 16"><path d="M3 7h10v2H3z" /></symbol>
  <symbol id="gitna-action-discard" viewBox="0 0 16 16"><path d="M6 3v2h4a4 4 0 1 1 0 8H8v-2h2a2 2 0 1 0 0-4H6v2L2 6l4-4v1z" /></symbol>
  <symbol id="gitna-action-open-file" viewBox="0 0 16 16"><path d="M3 2h7l3 3v9H3V2zm2 2v8h6V6H9V4H5zm1 3h4v1.5H6V7zm0 2.5h4V11H6V9.5z" /></symbol>
</svg>`;

const SHARED_FILE_TREE_UNSAFE_CSS = `${HIDDEN_SEARCH_UNSAFE_CSS}\n${SIDEBAR_VIRTUALIZED_SCROLL_UNSAFE_CSS}\n${FOLDER_LABEL_UNSAFE_CSS}`;

// Options shared across all mounts of this tree. Lives at module scope so the
// reference stays stable and useFileTree() never churns its initial snapshot.
export const BASE_FILE_TREE_OPTIONS = {
  flattenEmptyDirectories: true,
  id: 'gh-code-view-tree',
  initialExpansion: 'open',
  icons: { set: 'complete', spriteSheet: FILE_TREE_ACTION_SPRITE_SHEET },
  presorted: true,
  search: true,
  stickyFolders: true,
  unsafeCSS: `${SHARED_FILE_TREE_UNSAFE_CSS}\n${SUPPRESS_FOLDER_DOT_UNSAFE_CSS}`,
} as const satisfies Omit<FileTreeOptions, 'paths' | 'preparedInput'>;

// Unlike diff-only trees, the repository mixes changed and unchanged files,
// so changed-descendant dots carry useful information and stay visible.
export const REPOSITORY_FILE_TREE_OPTIONS = {
  ...BASE_FILE_TREE_OPTIONS,
  unsafeCSS: SHARED_FILE_TREE_UNSAFE_CSS,
} as const satisfies Omit<FileTreeOptions, 'paths' | 'preparedInput'>;
