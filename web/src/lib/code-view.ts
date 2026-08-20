/**
 * Adapted from Pierre DiffsHub DiffsHubViewer.tsx and lib/constants.ts at
 * diffs-v1.3.5 (59ec35ffac97abccef4c69f8d58d3747cbfbc6cb).
 * Replaces the React wrapper with one long-lived vanilla CodeView lifecycle.
 * Apache-2.0; Copyright 2025 Pierre Computer Company.
 */
import {
  CodeView,
  type CodeViewItem,
  type CodeViewOptions,
  type DiffIndicators,
} from "@pierre/diffs";
import type { ApiClient } from "./api";
import { createReviewDiffLoader, reviewToItems, type ReviewItemStatus } from "./review-data";
import type { ReviewResponse } from "./types";

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
  private pathToItemId = new Map<string, string>();
  private statusByItemId = new Map<string, ReviewItemStatus>();
  private loader: CodeViewOptions<undefined>["loadDiffFiles"];

  constructor(
    root: HTMLElement,
    private readonly api: ApiClient,
    display: CodeViewDisplayOptions,
  ) {
    this.display = display;
    this.viewer.setOptions(this.buildOptions());
    this.viewer.setup(root);
  }

  setReview(review: ReviewResponse): number {
    const converted = reviewToItems(review);
    this.items = converted.items;
    this.pathToItemId = converted.pathToItemId;
    this.statusByItemId = converted.statusByItemId;
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
      renderHeaderPrefix: (_fileDiff, context) => {
        const item = context.item;
        return this.collapseButton(item);
      },
      renderHeaderMetadata: (_fileDiff, context) => {
        const status = this.statusByItemId.get(context.item.id);
        if (!status) return null;
        const badge = document.createElement("span");
        badge.className = "review-file-status";
        badge.textContent = status === "binary" ? "Binary" : "Too large";
        return badge;
      },
    };
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
