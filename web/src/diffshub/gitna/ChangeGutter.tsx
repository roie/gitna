import { useEffect, useState, type RefObject } from 'react'
import type { ApiClient } from '../../lib/api'
import { fileGutterChanges, installChangeGutter, type GutterChange } from './changeGutter'

export function ChangeGutter({
  path,
  generation,
  contents,
  api,
  scrollRef,
}: {
  path: string
  generation: number
  contents: string | undefined
  api: ApiClient
  scrollRef: RefObject<HTMLDivElement | null>
}) {
  const [baseline, setBaseline] = useState<string | null>(null)
  const [changes, setChanges] = useState<ReadonlyMap<number, GutterChange>>(new Map())

  useEffect(() => {
    let active = true
    void api.diff({ scope: 'unstaged', path }).then(
      (diff) => {
        if (active) setBaseline(diff.binary || diff.tooLarge ? null : diff.before.content)
      },
      () => {
        if (active) setBaseline(null)
      },
    )
    return () => {
      active = false
    }
  }, [api, path, generation])

  useEffect(() => {
    const timer = setTimeout(() => {
      setChanges(
        baseline == null || contents == null ? new Map() : fileGutterChanges(baseline, contents),
      )
    }, 120)
    return () => clearTimeout(timer)
  }, [baseline, contents])

  useEffect(() => {
    const container = scrollRef.current
    if (container == null) return
    return installChangeGutter(container, changes)
  }, [scrollRef, changes])

  return null
}
