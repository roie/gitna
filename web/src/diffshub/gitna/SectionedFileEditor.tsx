import type { FileContents } from '@pierre/diffs'
import type { EditorViewState } from '@pierre/diffs/edit'
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from 'react'
import { SectionedEditor, EDITOR_SECTION_LENGTH } from '../../lib/sectioned-editor'
import { WorktreeHeaderActions, type GitnaEditorActions } from '../components/DiffsHubViewer'

export interface SectionedFileEditorHandle {
  focus(line: number, column: number): void
}

export function SectionedFileEditor({
  file,
  label = file.name,
  actions,
  model,
  onViewStateChange,
  onReady,
  ref,
}: {
  file: FileContents
  label?: string
  actions: GitnaEditorActions
  model: SectionedEditor
  onViewStateChange: (state: EditorViewState) => void
  onReady: () => void
  ref?: Ref<SectionedFileEditorHandle>
}) {
  const [revision, setRevision] = useState(0)
  const input = useRef<HTMLTextAreaElement>(null)
  const focusRequested = useRef(true)
  const refresh = () => setRevision((value) => value + 1)
  const focusOffset = (offset: number) => {
    model.reveal(offset)
    focusRequested.current = true
    refresh()
  }
  useImperativeHandle(ref, () => ({
    focus(line, column) {
      focusOffset(model.document.offsetAt({ line: Math.max(0, line - 1), character: column }))
    },
  }))
  useEffect(() => onReady(), [onReady])
  useLayoutEffect(() => {
    const element = input.current
    if (element == null) return
    element.setSelectionRange(model.selectionStart, model.selectionEnd)
    if (focusRequested.current) {
      focusRequested.current = false
      // Refocusing scrolls the native caret into view after a section jump.
      element.blur()
      element.focus()
    }
  }, [model, revision])
  const publish = () => {
    refresh()
    actions.onChange(
      file.name,
      { name: file.name, contents: model.document.getText() },
      model.viewState,
    )
  }
  const buttonClass =
    'rounded px-2 py-1 text-xs disabled:opacity-40 active:bg-accent focus-visible:outline-2 focus-visible:outline-ring'
  return (
    <section
      className="flex h-full min-h-0 flex-col bg-background"
      aria-label={`Section editor for ${label}`}
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2 text-sm">
        <span className="min-w-0 break-all">{label}</span>
        <WorktreeHeaderActions actions={{ ...actions, previewMode: undefined }} path={file.name} />
      </header>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-xs text-muted-foreground">
        <p id="section-editor-help">
          Extreme line length: editing one section at a time. Save writes the entire file. Selection
          and copy apply to this section.
        </p>
        <nav className="flex flex-wrap items-center gap-1" aria-label="File sections">
          <button
            type="button"
            className={buttonClass}
            disabled={model.start === 0}
            onClick={() => focusOffset(0)}
          >
            First section
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={model.start === 0}
            onClick={() => focusOffset(Math.max(0, model.start - EDITOR_SECTION_LENGTH / 2))}
          >
            Previous section
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={model.end === model.length}
            onClick={() =>
              focusOffset(Math.min(model.length, model.end + EDITOR_SECTION_LENGTH / 2))
            }
          >
            Next section
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={model.end === model.length}
            onClick={() => focusOffset(model.length)}
          >
            Last section
          </button>
        </nav>
        <span role="status">
          Offsets {model.start.toLocaleString()}–{model.end.toLocaleString()} of{' '}
          {model.length.toLocaleString()} (UTF-16)
        </span>
      </div>
      <textarea
        ref={input}
        aria-label={`Edit section of ${label}`}
        aria-describedby="section-editor-help"
        className="min-h-0 w-full flex-1 resize-none bg-background p-4 font-mono text-sm leading-6 text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        value={model.text}
        onSelect={(event) => {
          model.select(event.currentTarget.selectionStart, event.currentTarget.selectionEnd)
          onViewStateChange(model.viewState)
        }}
        onChange={(event) => {
          model.replace(
            event.currentTarget.value,
            event.currentTarget.selectionStart,
            event.currentTarget.selectionEnd,
          )
          if (event.currentTarget.value !== model.text) focusRequested.current = true
          publish()
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.altKey) return
          const command = event.ctrlKey || event.metaKey
          const key = event.key.toLowerCase()
          if (command && (key === 'z' || key === 'y')) {
            event.preventDefault()
            if (model.history(key === 'y' || event.shiftKey)) {
              focusRequested.current = true
              publish()
            }
          } else if (command && !event.shiftKey && (key === 'home' || key === 'end')) {
            event.preventDefault()
            focusOffset(key === 'home' ? 0 : model.length)
          } else if (!command && !event.shiftKey && model.selectionStart === model.selectionEnd) {
            if (
              key === 'arrowright' &&
              model.selectionEnd === model.text.length &&
              model.end < model.length
            ) {
              event.preventDefault()
              focusOffset(model.end)
            } else if (key === 'arrowleft' && model.selectionStart === 0 && model.start > 0) {
              event.preventDefault()
              focusOffset(model.start - 1)
            }
          }
        }}
      />
    </section>
  )
}
