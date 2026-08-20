import {
  parseDiffFromFile,
  parsePatchFiles,
  type CodeViewItem,
  type FileContents,
  type FileDiffContentsLoader,
  type FileDiffMetadata,
} from "@pierre/diffs";
import type { ApiClient, ReviewRequest } from "./api";
import type { ReviewIdentity, ReviewResponse } from "./types";

export type ReviewItemStatus = "binary" | "too-large";

export interface ReviewItems {
  items: CodeViewItem[];
  pathToItemId: Map<string, string>;
  statusByItemId: Map<string, ReviewItemStatus>;
}

export function reviewIdentityKey(identity: ReviewIdentity): string {
  return [identity.scope, identity.commit ?? "", identity.from ?? "", identity.to ?? ""].join(":");
}

export function reviewRequestKey(request: ReviewRequest): string {
  return [request.scope, request.commit ?? "", request.from ?? "", request.to ?? ""].join(":");
}

export function reviewFileCount(review: ReviewResponse): number {
  return (review.patch.match(/^diff --git /gm)?.length ?? 0) + review.supplements.length;
}

function itemId(identity: ReviewIdentity, file: FileDiffMetadata): string {
  return `${reviewIdentityKey(identity)}:${file.prevName ?? ""}->${file.name}`;
}

/** Converts the server's bounded patch response into Pierre's native CodeView
 * item model. Patch parsing and diff construction remain entirely in Pierre. */
export function reviewToItems(review: ReviewResponse): ReviewItems {
  const items: CodeViewItem[] = [];
  const pathToItemId = new Map<string, string>();
  const statusByItemId = new Map<string, ReviewItemStatus>();

  if (review.patch) {
    const parsed = parsePatchFiles(review.patch, reviewIdentityKey(review.identity), true);
    for (const patch of parsed) {
      for (const file of patch.files) {
        const id = itemId(review.identity, file);
        items.push({ id, type: "diff", fileDiff: file });
        pathToItemId.set(file.name, id);
        if (file.prevName) pathToItemId.set(file.prevName, id);
      }
    }
  }

  for (const supplement of review.supplements) {
    const version: FileContents = {
      name: supplement.path,
      contents:
        supplement.diff.binary || supplement.diff.tooLarge ? "" : supplement.diff.after.content,
      lang: supplement.diff.after.language as FileContents["lang"],
      cacheKey: `${reviewIdentityKey(review.identity)}:${supplement.path}:${review.generation}`,
    };
    const file = parseDiffFromFile(null, version, undefined, true);
    const id = itemId(review.identity, file);
    items.push({ id, type: "diff", fileDiff: file });
    pathToItemId.set(supplement.path, id);
    if (supplement.diff.binary) statusByItemId.set(id, "binary");
    if (supplement.diff.tooLarge) statusByItemId.set(id, "too-large");
  }

  return { items, pathToItemId, statusByItemId };
}

/** Builds Pierre's partial-context loader on top of the existing typed /diff
 * endpoint. No Git argument or raw command text crosses this browser seam. */
export function createReviewDiffLoader(
  api: ApiClient,
  identity: ReviewIdentity,
): FileDiffContentsLoader {
  return async (fileDiff) => {
    const response = await api.diff({
      scope: identity.scope,
      path: fileDiff.name,
      oldPath: fileDiff.prevName,
      commit: identity.commit,
      from: identity.from,
      to: identity.to,
    });
    return {
      oldFile: {
        name: response.before.path,
        contents: response.before.content,
        lang: response.before.language as FileContents["lang"],
        cacheKey: `${reviewIdentityKey(identity)}:${response.before.path}:before`,
      },
      newFile: {
        name: response.after.path,
        contents: response.after.content,
        lang: response.after.language as FileContents["lang"],
        cacheKey: `${reviewIdentityKey(identity)}:${response.after.path}:after`,
      },
    };
  };
}
