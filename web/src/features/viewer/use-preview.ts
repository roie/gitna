import type { CodeViewHandle } from '@pierre/diffs/react'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { CommentMetadata } from '../../lib/review-types'
import type { MarkdownViewMode as FilePreviewMode } from './preview/markdown-preview'
import {
  scrollPreviewToSourceLine,
  sourceLineAtEditorTop,
  sourceLineAtPreviewTop,
} from './preview/markdown-scroll'

export function usePreview(
  previewFilePath: string | undefined,
  scrollRef: RefObject<HTMLDivElement | null>,
  viewerRef: RefObject<CodeViewHandle<CommentMetadata, undefined> | null>,
) {
  const [filePreviewModes, setFilePreviewModes] = useState<Map<string, FilePreviewMode>>(
    () => new Map(),
  )
  const previewMode =
    previewFilePath == null ? 'editor' : (filePreviewModes.get(previewFilePath) ?? 'editor')
  const setPreviewMode = useCallback(
    (mode: FilePreviewMode) => {
      if (previewFilePath == null) return
      setFilePreviewModes((modes) => new Map(modes).set(previewFilePath, mode))
    },
    [previewFilePath],
  )
  const [cachedPreviewPath, setCachedPreviewPath] = useState<string | null>(null)
  const [cachedPreviewMode, setCachedPreviewMode] = useState<'preview' | 'split'>('split')
  const previewLayoutMode = previewMode === 'editor' ? cachedPreviewMode : previewMode
  useEffect(() => {
    if (previewMode !== 'editor') {
      setCachedPreviewPath(previewFilePath ?? null)
      setCachedPreviewMode(previewMode)
    }
  }, [previewMode, previewFilePath])

  const previewScrollRef = useRef<HTMLElement | null>(null)
  const scrollOriginRef = useRef<'editor' | 'preview' | null>(null)
  const scrollGuardTimerRef = useRef<number | null>(null)
  const previousPreviewModeRef = useRef(previewMode)
  useEffect(() => {
    previousPreviewModeRef.current = previewMode
  }, [previewMode])

  const guardScroll = useCallback((origin: 'editor' | 'preview') => {
    scrollOriginRef.current = origin
    if (scrollGuardTimerRef.current != null) window.clearTimeout(scrollGuardTimerRef.current)
    scrollGuardTimerRef.current = window.setTimeout(() => {
      scrollOriginRef.current = null
      scrollGuardTimerRef.current = null
    }, 120)
  }, [])

  const claimScroll = useCallback(
    (origin: 'editor' | 'preview', key?: string) => {
      if (previewMode !== 'split') return
      if (
        key != null &&
        !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(key)
      )
        return
      // User input takes over immediately, even inside the feedback guard.
      guardScroll(origin)
    },
    [guardScroll, previewMode],
  )

  const syncPreviewFromEditor = useCallback(() => {
    const scroller = scrollRef.current
    const preview = previewScrollRef.current
    if (scroller == null || preview == null || scrollOriginRef.current === 'preview') return
    const line = sourceLineAtEditorTop(scroller)
    if (line == null) return
    const before = preview.scrollTop
    scrollPreviewToSourceLine(preview, line)
    if (Math.abs(preview.scrollTop - before) > 1) guardScroll('editor')
  }, [guardScroll, scrollRef])

  const handlePreviewMount = useCallback(
    (element: HTMLElement | null) => {
      previewScrollRef.current = element
      if (element == null || previewMode !== 'split') return
      if (previousPreviewModeRef.current === 'preview' && previewFilePath != null) {
        guardScroll('preview')
        viewerRef.current?.scrollTo({
          type: 'line',
          id: previewFilePath,
          lineNumber: sourceLineAtPreviewTop(element) - 1,
          align: 'start',
        })
      } else {
        requestAnimationFrame(syncPreviewFromEditor)
      }
    },
    [guardScroll, previewMode, syncPreviewFromEditor, previewFilePath, viewerRef],
  )

  const handlePreviewScroll = useCallback(
    (element: HTMLElement) => {
      if (
        previewMode !== 'split' ||
        scrollOriginRef.current === 'editor' ||
        previewFilePath == null
      )
        return
      guardScroll('preview')
      viewerRef.current?.scrollTo({
        type: 'line',
        id: previewFilePath,
        lineNumber: sourceLineAtPreviewTop(element) - 1,
        align: 'start',
      })
    },
    [guardScroll, previewMode, previewFilePath, viewerRef],
  )

  const handleEditorScroll = useCallback(() => {
    if (previewMode === 'split' && scrollOriginRef.current !== 'preview') {
      requestAnimationFrame(syncPreviewFromEditor)
    }
  }, [previewMode, syncPreviewFromEditor])

  const markdownPath =
    previewFilePath != null && /\.(md|markdown|mdown|mkdn)$/i.test(previewFilePath)
      ? previewFilePath
      : null
  const svgPath =
    previewFilePath != null && /\.svg$/i.test(previewFilePath) ? previewFilePath : null
  const previewPath = markdownPath ?? svgPath
  const previewLabel: 'SVG' | 'Markdown' = svgPath != null ? 'SVG' : 'Markdown'

  return {
    cachedPreviewPath,
    claimScroll,
    handleEditorScroll,
    handlePreviewMount,
    handlePreviewScroll,
    markdownPath,
    previewLabel,
    previewLayoutMode,
    previewMode,
    previewPath,
    setPreviewMode,
    svgPath,
  }
}
