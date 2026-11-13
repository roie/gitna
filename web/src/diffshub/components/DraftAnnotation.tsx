// Modified by Gitna: declare callbacks as receiver-independent function properties,
// show the real author, save asynchronously, share the form as CommentComposer, and
// let it pick a recipient.
import type { DiffLineAnnotation } from '@pierre/diffs';
import { IconArrowRight } from '@pierre/icons';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/Button';
import { annotationCardBase } from '@/lib/annotation';
import { cn } from '@/lib/cn';
import type { DraftCommentMetadata } from '@/lib/types';

interface DraftAnnotationProps {
  annotation: DiffLineAnnotation<DraftCommentMetadata>;
  author: string;
  itemId: string;
  recipients?: Recipients | null;
  onCancel: (itemId: string, key: string) => void;
  onSave: (itemId: string, key: string, message: string, to?: string) => void | Promise<void>;
}

/** Agents a comment can be addressed to, and the label of the default choice. */
export interface Recipients {
  choices: readonly { id: string; label: string }[];
  defaultLabel: string;
}

interface CommentComposerProps {
  avatar: ReactNode;
  autoFocus?: boolean;
  className?: string;
  initialMessage?: string;
  placeholder?: string;
  recipients?: Recipients | null;
  onCancel?: () => void;
  onChange?: (message: string) => void;
  onSubmit: (message: string, to?: string) => void | Promise<void>;
}

// Keep typing and clicks inside a comment from reaching an editable code view.
const isolate = (event: { stopPropagation(): void }) => event.stopPropagation();

export function CommentComposer({
  avatar,
  autoFocus = false,
  className,
  initialMessage = '',
  placeholder = 'Add a comment…',
  recipients,
  onCancel,
  onChange,
  onSubmit,
}: CommentComposerProps) {
  const [message, setMessage] = useState(initialMessage);
  const [recipient, setRecipient] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const trimmedMessage = message.trim();

  async function handleSave() {
    if (trimmedMessage.length === 0 || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmedMessage, recipient === '' ? undefined : recipient);
      setMessage('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  function tryCancel() {
    if (onCancel == null) {
      return;
    }
    if (trimmedMessage.length > 0 && !window.confirm('Discard this comment?')) {
      return;
    }
    onCancel();
  }

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!autoFocus || textarea == null) {
      return;
    }

    textarea.focus({ preventScroll: true });
    const cursorIndex = textarea.value.length;
    textarea.setSelectionRange(cursorIndex, cursorIndex);
  }, [autoFocus]);

  return (
    <form
      className={cn(annotationCardBase, 'flex-col md:flex-row', className)}
      onKeyDown={isolate}
      onPointerDown={isolate}
      onMouseDown={isolate}
      onBeforeInput={isolate}
      onPaste={isolate}
      onSubmit={(event) => {
        event.preventDefault();
        void handleSave();
      }}
    >
      <div className="flex w-full gap-2.5">
        {avatar}
        <div className="flex w-full flex-col">
          <textarea
            ref={textareaRef}
            value={message}
            disabled={busy}
            aria-label={placeholder}
            onChange={({ currentTarget }) => {
              setMessage(currentTarget.value);
              onChange?.(currentTarget.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                tryCancel();
                return;
              }

              if (
                (!event.shiftKey && !event.metaKey && !event.ctrlKey) ||
                event.key !== 'Enter'
              ) {
                return;
              }

              event.preventDefault();
              void handleSave();
            }}
            placeholder={placeholder}
            rows={2}
            className="field-sizing-content w-full resize-none [caret-color:auto] rounded-sm bg-transparent py-1.5 text-[14px] text-inherit placeholder:text-[var(--diffshub-popover-muted-fg,var(--color-muted-foreground))] focus:outline-none"
          />
          {error != null && (
            <p role="alert" className="m-0 text-xs text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
        </div>
      </div>
      <div className="flex w-full items-center justify-between gap-3 pl-10.5 md:w-auto md:justify-end md:pl-0">
        {recipients != null && (
          <select
            aria-label="To"
            value={recipient}
            disabled={busy}
            onChange={({ currentTarget }) => setRecipient(currentTarget.value)}
            className="max-w-40 truncate rounded-sm border border-border bg-transparent px-1 py-0.5 text-xs text-inherit"
          >
            <option value="">{recipients.defaultLabel}</option>
            {recipients.choices.map(({ id, label }) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        )}
        {onCancel != null && (
          <Button
            type="button"
            variant="muted"
            onClick={tryCancel}
            className="text-muted-foreground hover:text-foreground gap-1 font-normal hover:no-underline md:hidden"
          >
            Cancel
          </Button>
        )}
        <Button
          type="submit"
          variant="default"
          size="icon-md"
          aria-label="Submit"
          disabled={busy || trimmedMessage.length === 0}
          className="hidden rounded-full bg-blue-500 hover:bg-blue-600 md:flex"
        >
          <IconArrowRight className="size-4 rotate-[-90deg]" />
        </Button>
        <Button
          type="submit"
          variant="default"
          disabled={busy || trimmedMessage.length === 0}
          className="gap-1.5 bg-blue-500 hover:bg-blue-600 md:hidden"
        >
          Submit
          <IconArrowRight className="-mr-0.5 size-3" />
        </Button>
      </div>
    </form>
  );
}

export function AuthorInitial({
  name,
  agent = false,
  className,
}: {
  name: string;
  agent?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-8 shrink-0 items-center justify-center self-start rounded-full text-[13px] font-semibold uppercase',
        agent
          ? 'bg-violet-500/20 text-violet-700 dark:text-violet-300'
          : 'bg-blue-500/20 text-blue-700 dark:text-blue-300',
        className
      )}
    >
      {name.slice(0, 1)}
    </span>
  );
}

export function DraftAnnotation({
  annotation,
  author,
  itemId,
  recipients,
  onCancel,
  onSave,
}: DraftAnnotationProps) {
  const { metadata } = annotation;
  const composer = (
    <CommentComposer
      autoFocus
      avatar={<AuthorInitial name={author} />}
      initialMessage={metadata.message}
      recipients={recipients}
      onCancel={() => onCancel(itemId, metadata.key)}
      onChange={(message) => {
        metadata.message = message;
      }}
      onSubmit={(message, to) => onSave(itemId, metadata.key, message, to)}
    />
  );
  if (metadata.outdated !== true) {
    return composer;
  }
  return (
    <div className="flex flex-col gap-2">
      <pre className="m-0 max-h-40 overflow-auto rounded-md border border-border px-2 py-1 font-mono text-xs">
        {metadata.code}
      </pre>
      {composer}
    </div>
  );
}
