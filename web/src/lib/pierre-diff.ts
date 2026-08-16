import { FileDiff as PierreFileDiff, type FileContents, type MaybeDiffFileInput } from '@pierre/diffs'
import type { ChangeKind, FileDiff } from './types'

export type DiffSides = MaybeDiffFileInput

/**
 * Map a normalized FileDiff and its change kind onto the two FileContents
 * sides the Pierre FileDiff component expects. Added and deleted changes pass
 * null for the side that does not exist so the component renders a proper
 * add/delete diff instead of an empty change.
 */
export function toDiffSides(diff: FileDiff, kind: ChangeKind): DiffSides {
  const before: FileContents = {
    name: diff.before.path,
    contents: diff.before.content,
  }
  const after: FileContents = {
    name: diff.after.path,
    contents: diff.after.content,
  }
  if (diff.before.language) before.lang = diff.before.language
  if (diff.after.language) after.lang = diff.after.language

  if (kind === 'added' || kind === 'untracked') return { oldFile: null, newFile: after }
  if (kind === 'deleted') return { oldFile: before, newFile: null }
  return { oldFile: before, newFile: after }
}

/**
 * Thin adapter over the Pierre Diffs vanilla FileDiff component. A fresh
 * instance is created per file because each render owns its file container;
 * the previous instance is torn down before the next one mounts.
 */
export class ChangeDiff {
  private view: PierreFileDiff | null = null

  constructor(private readonly mount: HTMLElement) {}

  update(diff: FileDiff, kind: ChangeKind): void {
    this.teardown()
    const sides = toDiffSides(diff, kind)
    this.view = new PierreFileDiff({
      theme: { dark: 'pierre-dark', light: 'pierre-light' },
      diffStyle: 'unified',
    })
    this.view.render({
      containerWrapper: this.mount,
      ...sides,
    })
  }

  destroy(): void {
    this.teardown()
  }

  private teardown(): void {
    this.view?.cleanUp()
    this.view = null
    this.mount.replaceChildren()
  }
}
