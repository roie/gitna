import { useEffect, useRef, useState, type RefObject } from 'react'
import type { ApiClient } from '../../lib/api'
import { installChangeGutter, type GutterChange } from './changeGutter'

export function ChangeGutter({
  path,
  indexRevision,
  contents,
  maxBytes,
  api,
  scrollRef,
}: {
  path: string
  indexRevision: number
  contents: string | undefined
  maxBytes?: number
  api: ApiClient
  scrollRef: RefObject<HTMLDivElement | null>
}) {
  const [loadedBaseline, setBaseline] = useState<{ path: string; content: string | null } | null>(
    null,
  )
  const baseline = loadedBaseline?.path === path ? loadedBaseline.content : null
  const compute = useRef<((before: string | null, after: string | undefined) => void) | null>(null)

  useEffect(() => {
    const container = scrollRef.current
    if (container == null) return
    const painter = installChangeGutter(container)
    let worker: Worker | null = null
    let busy = false
    let version = 0
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    let pending: { before: string; after: string; version: number } | null = null
    const pump = () => {
      if (busy || pending == null || disposed) return
      const request = pending
      pending = null
      const current =
        worker ??
        new Worker(new URL('./changeGutterWorker.ts', import.meta.url), { type: 'module' })
      worker = current
      busy = true
      const stop = () => {
        current.terminate()
        worker = null
        busy = false
      }
      const failed = () => {
        clearTimeout(deadline)
        stop()
        if (!disposed && request.version === version) painter.update(new Map())
        pump()
      }
      current.onmessage = (event: MessageEvent<Map<number, GutterChange> | null>) => {
        clearTimeout(deadline)
        busy = false
        if (!disposed && request.version === version) painter.update(event.data ?? new Map())
        pump()
      }
      current.onerror = failed
      deadline = setTimeout(failed, 500)
      current.postMessage({ before: request.before, after: request.after })
    }
    compute.current = (before, after) => {
      version += 1
      clearTimeout(timer)
      pending = null
      if (before == null || after == null || before === after) {
        painter.update(new Map())
        return
      }
      const request = { before, after, version }
      timer = setTimeout(() => {
        pending = request
        pump()
      }, 80)
    }
    return () => {
      disposed = true
      clearTimeout(timer)
      clearTimeout(deadline)
      compute.current = null
      worker?.terminate()
      painter.dispose()
    }
  }, [scrollRef])

  useEffect(() => {
    const controller = new AbortController()
    if (api.indexBaseline == null) return
    void api.indexBaseline(path, controller.signal, maxBytes).then(
      (result) => {
        if (!controller.signal.aborted)
          setBaseline({
            path,
            content: result.present && !result.binary && !result.tooLarge ? result.content : null,
          })
      },
      () => {
        if (!controller.signal.aborted) setBaseline({ path, content: null })
      },
    )
    return () => controller.abort()
  }, [api, path, indexRevision, maxBytes])

  useEffect(() => {
    compute.current?.(baseline, contents)
  }, [baseline, contents])

  return null
}
