// Adapted from Pierre DiffsHub DiffsHubViewer.tsx and lib/constants.ts at
// diffs-v1.3.5 (59ec35ffac97abccef4c69f8d58d3747cbfbc6cb).
// Replaces the React wrapper with one long-lived vanilla CodeView lifecycle.
// Apache-2.0; Copyright 2025 Pierre Computer Company.
import {
  CodeView,
  type CodeViewItem,
  type CodeViewOptions,
  type DiffIndicators,
} from "@pierre/diffs";
import type { ApiClient, MutateRequest } from "./api";
import { splitHunkPatches } from "./hunk-patches";
import { createReviewDiffLoader, reviewToItems, type ReviewItemStatus } from "./review-data";
import type { ChangeKind, ReviewIdentity, ReviewResponse } from "./types";

export interface CodeViewDisplayOptions {
  diffStyle: "split" | "unified";
  overflow: "wrap" | "scroll";
  backgrounds: boolean;
  lineNumbers: boolean;
  diffIndicators: DiffIndicators;
  themeType: "system" | "light" | "dark";
  lightThemeName: string;
  darkThemeName: string;
}

export type ReviewFileAction = "stage" | "unstage" | "discard" | "delete";

export interface ReviewCodeViewActions {
  kindForPath(scope: "staged" | "unstaged", path: string): ChangeKind | undefined;
  onFileAction(action: ReviewFileAction, path: string, kind: ChangeKind): Promise<void> | void;
  onPatch(request: MutateRequest): Promise<void>;
  onActionStart(): void;
  onActionError(error: string): void;
}

const CODE_VIEW_CSS = `
[data-diffs-header] {
  container-type: scroll-state;
  container-name: sticky-header;
}
@container sticky-header scroll-state(stuck: top) {
  [data-diffs-header]::after {
    position: absolute;
    inset: auto 0 -1px;
    height: 1px;
    content: '';
    background: var(--diffshub-annotation-border, var(--color-border));
  }
}
`;

export class ReviewCodeView {
  private readonly viewer = new CodeView();
  private display: CodeViewDisplayOptions;
  private items: CodeViewItem[] = [];
  private orderedPaths: string[] = [];
  private pathToItemId = new Map<string, string>();
  private statusByItemId = new Map<string, ReviewItemStatus>();
  private identity: ReviewIdentity | null = null;
  private loader: CodeViewOptions<undefined>["loadDiffFiles"];
  private actions?: ReviewCodeViewActions;

  constructor(
    root: HTMLElement,
    private readonly api: ApiClient,
    display: CodeViewDisplayOptions,
  ) {
    this.display = display;
    this.viewer.setOptions(this.buildOptions());
    this.viewer.setup(root);
  }

  setActions(actions: ReviewCodeViewActions): void {
    this.actions = actions;
    this.viewer.setOptions(this.buildOptions());
  }

  setReview(review: ReviewResponse): number {
    const converted = reviewToItems(review);
    this.items = converted.items;
    this.orderedPaths = converted.items.flatMap((item) =>
      item.type === "diff" ? [item.fileDiff.name] : [],
    );
    this.pathToItemId = converted.pathToItemId;
    this.statusByItemId = converted.statusByItemId;
    this.identity = review.identity;
    this.loader = createReviewDiffLoader(this.api, review.identity);
    this.viewer.setOptions(this.buildOptions());
    this.viewer.setItems(this.items);
    return this.items.length;
  }

  get itemCount(): number {
    return this.items.length;
  }

  setDisplay(display: CodeViewDisplayOptions): void {
    this.display = display;
    this.viewer.setOptions(this.buildOptions());
  }

  collapseAll(collapsed: boolean): void {
    for (const original of this.items) {
      const item = this.viewer.getItem(original.id);
      if (!item || item.collapsed === collapsed) continue;
      item.collapsed = collapsed;
      item.version = (item.version ?? 0) + 1;
      this.viewer.updateItem(item);
    }
  }

  scrollToPath(path: string): void {
    const id = this.pathToItemId.get(path);
    if (!id) return;
    const item = this.viewer.getItem(id);
    if (item?.collapsed) {
      item.collapsed = false;
      item.version = (item.version ?? 0) + 1;
      this.viewer.updateItem(item);
    }
    this.viewer.scrollTo({ type: "item", id, align: "start", behavior: "smooth" });
  }

  scrollAdjacent(path: string | undefined, offset: -1 | 1): string | null {
    if (this.orderedPaths.length === 0) return null;
    const current = path ? this.orderedPaths.indexOf(path) : -1;
    const index =
      current < 0
        ? offset > 0
          ? 0
          : this.orderedPaths.length - 1
        : (current + offset + this.orderedPaths.length) % this.orderedPaths.length;
    const next = this.orderedPaths[index]!;
    this.scrollToPath(next);
    return next;
  }

  cleanUp(): void {
    this.viewer.cleanUp();
  }

  private toggleItem(id: string): void {
    const item = this.viewer.getItem(id);
    if (!item) return;
    item.collapsed = !item.collapsed;
    item.version = (item.version ?? 0) + 1;
    this.viewer.updateItem(item);
  }

  private buildOptions(): CodeViewOptions<undefined> {
    return {
      layout: { paddingTop: 0, gap: 1, paddingBottom: 0 },
      theme: { light: this.display.lightThemeName, dark: this.display.darkThemeName },
      themeType: this.display.themeType,
      diffStyle: this.display.diffStyle,
      diffIndicators: this.display.diffIndicators,
      overflow: this.display.overflow,
      loadDiffFiles: this.loader,
      disableBackground: !this.display.backgrounds,
      disableLineNumbers: !this.display.lineNumbers,
      lineHoverHighlight: "number",
      stickyHeaders: true,
      unsafeCSS: CODE_VIEW_CSS,
      renderHeaderPrefix: (_fileDiff, context) => this.collapseButton(context.item),
      renderHeaderMetadata: (_fileDiff, context) => this.headerMetadata(context.item),
    };
  }

  private headerMetadata(item: CodeViewItem): HTMLElement | null {
    if (item.type !== "diff") return null;
    const status = this.statusByItemId.get(item.id);
    const identity = this.identity;
    const workingScope = identity?.scope === "staged" || identity?.scope === "unstaged";
    if (!status && !workingScope) return null;

    const metadata = document.createElement("span");
    metadata.className = "review-header-metadata";
    if (status) {
      const badge = document.createElement("span");
      badge.className = "review-file-status";
      badge.textContent = status === "binary" ? "Binary" : "Too large";
      metadata.append(badge);
    }
    if (
      !identity ||
      (identity.scope !== "staged" && identity.scope !== "unstaged") ||
      !this.actions
    )
      return metadata;

    const scope = identity.scope;
    const path = item.fileDiff.name;
    const kind = this.actions.kindForPath(scope, path) ?? this.inferKind(item);
    const primary = scope === "staged" ? "unstage" : "stage";
    metadata.append(this.fileActionButton(primary, path, kind));
    if (scope === "unstaged") {
      metadata.append(
        this.fileActionButton(kind === "untracked" ? "delete" : "discard", path, kind),
      );
    }
    if (item.fileDiff.hunks.length > 0 && kind === "modified") {
      metadata.append(this.hunkLauncher(path));
    }
    return metadata;
  }

  private inferKind(item: Extract<CodeViewItem, { type: "diff" }>): ChangeKind {
    switch (item.fileDiff.type) {
      case "new":
        return "added";
      case "deleted":
        return "deleted";
      case "rename-pure":
      case "rename-changed":
        return "renamed";
      default:
        return "modified";
    }
  }

  private fileActionButton(
    action: ReviewFileAction,
    path: string,
    kind: ChangeKind,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "review-git-action";
    button.dataset.action = action;
    button.textContent = action[0]!.toUpperCase() + action.slice(1);
    button.ariaLabel = `${button.textContent} file ${path}`;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!this.actions) return;
      this.actions.onActionStart();
      const result = this.actions.onFileAction(action, path, kind);
      if (result instanceof Promise) {
        button.disabled = true;
        void result
          .catch((error: unknown) => this.reportError(error))
          .finally(() => {
            button.disabled = false;
          });
      }
    });
    return button;
  }

  private hunkLauncher(path: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "review-git-action";
    button.textContent = "Hunks";
    button.ariaLabel = `Show hunk actions for ${path}`;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.loadHunkActions(button, path);
    });
    return button;
  }

  private async loadHunkActions(button: HTMLButtonElement, path: string): Promise<void> {
    const identity = this.identity;
    if (!identity || (identity.scope !== "staged" && identity.scope !== "unstaged")) return;
    this.actions?.onActionStart();
    button.disabled = true;
    button.textContent = "Loading…";
    try {
      const diff = await this.api.diff({ scope: identity.scope, path });
      if (identity !== this.identity) return;
      const hunks = splitHunkPatches(diff.patch ?? "");
      if (!diff.patchId || hunks.length === 0) {
        button.textContent = "No hunks";
        return;
      }
      const group = document.createElement("span");
      group.className = "review-hunk-actions";
      for (const [index, hunk] of hunks.entries()) {
        const hunkButton = document.createElement("button");
        const verb = identity.scope === "staged" ? "Unstage" : "Stage";
        hunkButton.type = "button";
        hunkButton.className = "review-git-action";
        hunkButton.textContent = `${verb} ${index + 1}`;
        hunkButton.ariaLabel = `${verb} hunk ${index + 1} in ${path}`;
        hunkButton.title = hunk.range;
        hunkButton.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!this.actions) return;
          this.actions.onActionStart();
          for (const child of group.querySelectorAll("button")) child.disabled = true;
          void this.actions
            .onPatch({
              op: "patch",
              patch: hunk.patch,
              patchId: diff.patchId,
              scope: identity.scope,
              path,
              reverse: identity.scope === "staged",
            })
            .catch((error: unknown) => this.reportError(error));
        });
        group.append(hunkButton);
      }
      button.replaceWith(group);
    } catch (error) {
      button.disabled = false;
      button.textContent = "Hunks";
      this.reportError(error);
    }
  }

  private reportError(error: unknown): void {
    this.actions?.onActionError(error instanceof Error ? error.message : String(error));
  }

  private collapseButton(item: CodeViewItem): HTMLButtonElement {
    const button = document.createElement("button");
    const disabled =
      item.type !== "diff" ||
      (item.fileDiff.splitLineCount === 0 && item.fileDiff.unifiedLineCount === 0);
    button.type = "button";
    button.disabled = disabled;
    button.className = "review-collapse-button";
    button.ariaExpanded = String(!disabled && !item.collapsed);
    button.ariaLabel = disabled ? "Empty diff" : item.collapsed ? "Expand diff" : "Collapse diff";

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M4.75 6.25 8 9.5l3.25-3.25");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.5");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
    button.append(svg);
    button.classList.toggle("is-collapsed", disabled || !!item.collapsed);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!disabled) this.toggleItem(item.id);
    });
    return button;
  }
}
