import type { DiffIndicators } from '@pierre/diffs'
import { useState } from 'react'
import { savePreference } from '../../lib/preferences'

export function useViewSettings() {
  const [diffStyle, setDiffStyle] = useState<'split' | 'unified'>('split')
  const [collapseMode, setCollapseMode] = useState<'expanded' | 'collapsed'>('expanded')
  const [overflow, setOverflow] = useState<'wrap' | 'scroll'>('wrap')
  const [showBackgrounds, setShowBackgrounds] = useState(true)
  const [inlineBlame, setInlineBlame] = useState(() => {
    try {
      return localStorage.getItem('gitna:inline-blame') !== 'false'
    } catch {
      return true
    }
  })
  const changeInlineBlame = (enabled: boolean) => {
    setInlineBlame(enabled)
    savePreference('gitna:inline-blame', String(enabled))
  }
  const [diffIndicators, setDiffIndicators] = useState<DiffIndicators>('bars')
  const [lineNumbers, setLineNumbers] = useState(true)

  return {
    diffStyle,
    setDiffStyle,
    collapseMode,
    setCollapseMode,
    overflow,
    setOverflow,
    showBackgrounds,
    setShowBackgrounds,
    inlineBlame,
    changeInlineBlame,
    diffIndicators,
    setDiffIndicators,
    lineNumbers,
    setLineNumbers,
  }
}
