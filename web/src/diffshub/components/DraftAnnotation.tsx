// Modified by Gitna: declare callbacks as receiver-independent function properties,
// show the real author, save asynchronously, share the form as CommentComposer, and
// let it pick a recipient, with a corner button to discard the draft like the
// conversation card's.
import type { DiffLineAnnotation } from '@pierre/diffs';
import { IconArrowRight, IconPlus, IconX } from '@pierre/icons';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/Button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/DropdownMenu';
import { annotationCardBase, annotationCornerButton } from '@/lib/annotation';
import { cn } from '@/lib/cn';
import type { DraftCommentMetadata } from '@/lib/types';
import type { Participant } from '../../lib/conversations';
import { mentionAt, removeMention, resolveMentions } from '../../lib/mentions';

interface DraftAnnotationProps {
  annotation: DiffLineAnnotation<DraftCommentMetadata>;
  author: string;
  itemId: string;
  agents: readonly Participant[];
  unsavedCount: number;
  onCancel: (itemId: string, key: string) => void;
  onSave: (itemId: string, key: string, message: string, to: string[]) => void | Promise<void>;
}

interface CommentComposerProps {
  avatar: ReactNode;
  autoFocus?: boolean;
  className?: string;
  initialText?: string;
  initialTo?: readonly string[];
  placeholder?: string;
  unsavedCount: number;
  agents: readonly Participant[];
  onCancel?: () => void;
  onChange?: (message: string) => void;
  onRecipientsChange?: (to: string[]) => void;
  onSubmit: (message: string, to: string[]) => void | Promise<void>;
}

// Keep typing and clicks inside a comment from reaching an editable code view.
const isolate = (event: { stopPropagation(): void }) => event.stopPropagation();

export function CommentComposer({
  avatar,
  autoFocus = false,
  className,
  initialText = '',
  initialTo = [],
  placeholder = 'Add a comment…',
  agents,
  unsavedCount,
  onCancel,
  onChange,
  onRecipientsChange,
  onSubmit,
}: CommentComposerProps) {
  const [message, setMessage] = useState(initialText);
  const [chosen, setChosen] = useState<readonly string[]>(initialTo);
  const [caret, setCaret] = useState<number | null>(null);
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const listboxID = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const trimmedMessage = message.trim();
  const mention = caret == null || dismissed ? null : mentionAt(message, caret);
  const choices = mention == null ? [] : [{ id: 'all', name: 'all' }, ...agents]
    .filter(({ name }) => name.toLowerCase().startsWith(mention.query.toLowerCase()));
  const active = Math.min(selected, choices.length - 1);
  const mentioned = resolveMentions(message, agents);
  const to = chosen.includes('all') || mentioned.includes('all') ? ['all'] : [...new Set([...chosen, ...mentioned])];
  const toNames = to.map((id) => id === 'all' ? 'all' : agents.find((agent) => agent.id === id)!.name);
  const everyone = to.includes('all') || agents.every(({ id }) => to.includes(id));
  const addable = everyone ? [] : [{ id: 'all', name: 'all' }, ...agents].filter(({ id }) => !to.includes(id));

  function setRecipients(next: readonly string[]) {
    setChosen(next);
    onRecipientsChange?.([...next]);
    requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
  }

  function remove(id: string) {
    const text = removeMention(message, id, agents);
    if (text !== message) {
      setMessage(text);
      onChange?.(text);
    }
    setRecipients(chosen.filter((candidate) => candidate !== id));
  }

  function choose(name: string) {
    if (mention == null || caret == null) return;
    const prefix = `${message.slice(0, mention.start)}@${name} `;
    const text = prefix + message.slice(caret);
    setMessage(text);
    onChange?.(text);
    setCaret(null);
    setDismissed(true);
    requestAnimationFrame(() => {
      textareaRef.current?.focus({ preventScroll: true });
      textareaRef.current?.setSelectionRange(prefix.length, prefix.length);
    });
  }

  async function handleSave() {
    if (trimmedMessage.length === 0 || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmedMessage, to);
      setMessage(initialText);
      setChosen(to);
      setCaret(null);
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
      className={cn(annotationCardBase, 'group relative flex-col md:flex-row', onCancel != null && 'md:pr-10', className)}
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
      {onCancel != null && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Discard comment"
          title="Discard comment"
          onClick={tryCancel}
          className={cn(annotationCornerButton, 'right-2 hidden md:flex')}
        >
          <IconX size={12} />
        </Button>
      )}
      <div className="flex w-full gap-2.5">
        {avatar}
        <div className="flex w-full flex-col">
          <textarea
            ref={textareaRef}
            value={message}
            disabled={busy}
            aria-label={placeholder}
            aria-autocomplete="list"
            aria-controls={choices.length > 0 ? listboxID : undefined}
            aria-activedescendant={choices.length > 0 ? `${listboxID}-${active}` : undefined}
            onSelect={({ currentTarget }) => setCaret(currentTarget.selectionStart)}
            onBlur={() => setCaret(null)}
            onChange={({ currentTarget }) => {
              setMessage(currentTarget.value);
              setCaret(currentTarget.selectionStart);
              setSelected(0);
              setDismissed(false);
              onChange?.(currentTarget.value);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              if (choices.length > 0) {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  setSelected((active + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length);
                  return;
                }
                if (event.key === 'Enter' || event.key === 'Tab') {
                  event.preventDefault();
                  choose(choices[active]!.name);
                  return;
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setDismissed(true);
                  return;
                }
              }
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
            rows={1}
            className="field-sizing-content w-full resize-none [caret-color:auto] rounded-sm bg-transparent py-1.5 text-[14px] text-inherit placeholder:text-muted-foreground focus:outline-none"
          />
          {choices.length > 0 && (
            <ul id={listboxID} role="listbox" aria-label="Mention an agent" className="m-0 flex list-none flex-col rounded-sm border border-border bg-background p-1">
              {choices.map(({ id, name }, index) => (
                <li key={id} role="presentation">
                  <button
                    type="button"
                    role="option"
                    id={`${listboxID}-${index}`}
                    aria-selected={index === active}
                    tabIndex={-1}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(name)}
                    className={cn('w-full rounded-sm px-2 py-1 text-start text-xs active:bg-accent focus-visible:outline-2', index === active && 'bg-accent')}
                  >
                    @{name}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {agents.length > 0 && (
            <div role="group" aria-label="Recipients" className="flex flex-wrap items-center gap-1 py-1 text-xs text-muted-foreground">
              {to.length > 0 && <span>To:</span>}
              {to.map((id, index) => (
                <span key={id} className="inline-flex items-center gap-0.5 rounded-full bg-muted py-0.5 pr-0.5 pl-2 text-foreground">
                  {toNames[index]}
                  <button
                    type="button"
                    aria-label={`Remove ${toNames[index]}`}
                    title={`Remove ${toNames[index]}`}
                    onClick={() => remove(id)}
                    className="rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <IconX size={10} />
                  </button>
                </span>
              ))}
              {addable.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label="Add recipient"
                      title="Add recipient"
                      className="h-5 gap-1 px-1 text-xs font-normal text-muted-foreground hover:text-foreground"
                    >
                      <IconPlus size={12} />
                      {to.length === 0 && 'Add recipient'}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {addable.map(({ id, name }) => (
                      <DropdownMenuItem key={id} onSelect={() => setRecipients(id === 'all' ? ['all'] : [...chosen, id])}>
                        @{name}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          )}
          {to.length > 0 && unsavedCount > 0 && <p className="m-0 py-1 text-xs text-muted-foreground">{unsavedCount} unsaved {unsavedCount === 1 ? 'file' : 'files'}. Agents see files on disk, not unsaved edits.</p>}
          {error != null && (
            <p role="alert" className="m-0 text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
      </div>
      <div className="flex w-full items-center justify-between gap-3 pl-10.5 md:w-auto md:justify-end md:pl-0">
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
          title="Submit"
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
          ? 'bg-[var(--gitna-agent)]/20 text-[var(--gitna-agent)]'
          : 'bg-highlight/20 text-highlight',
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
  agents,
  unsavedCount,
  onCancel,
  onSave,
}: DraftAnnotationProps) {
  const { metadata } = annotation;
  const composer = (
    <CommentComposer
      autoFocus
      avatar={<AuthorInitial name={author} />}
      initialText={metadata.message}
      initialTo={metadata.to}
      agents={agents}
      unsavedCount={unsavedCount}
      onCancel={() => onCancel(itemId, metadata.key)}
      onChange={(message) => {
        metadata.message = message;
      }}
      onRecipientsChange={(to) => {
        metadata.to = to;
      }}
      onSubmit={(message, to) => onSave(itemId, metadata.key, message, to)}
    />
  );
  return (
    <div className="flex flex-col gap-2">
      {metadata.outdated === true && (
        <pre className="m-0 max-h-40 overflow-auto rounded-md border border-border px-2 py-1 font-mono text-xs">
          {metadata.code}
        </pre>
      )}
      {composer}
    </div>
  );
}
