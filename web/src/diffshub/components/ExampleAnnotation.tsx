// Modified by Gitna: render a conversation's messages with real authors, add
// resolve beside delete, a per-message menu to delete one message, and accept a
// reply form as children.
import { IconCheck, IconEllipsis, IconX } from '@pierre/icons';
import { memo, type ReactNode } from 'react';

import { AuthorInitial } from './DraftAnnotation';
import { Button } from '@/components/Button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/DropdownMenu';
import { annotationCardBase } from '@/lib/annotation';
import { cn } from '@/lib/cn';

export interface ExampleAnnotationMessage {
  id: string;
  author: string;
  agent: boolean;
  message: string;
}

interface ExampleAnnotationProps {
  messages: readonly ExampleAnnotationMessage[];
  children?: ReactNode;
  onSelect: () => void;
  onDelete: () => void;
  onDeleteMessage: (id: string) => void;
  onResolve: () => void;
}

const cornerButton =
  'pointer-events-none absolute top-0 z-1 inline-flex -translate-y-[35%] cursor-pointer items-center justify-center rounded-full bg-neutral-500 opacity-0 transition-opacity duration-100 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100';

// Keep clicks and typing inside a comment from reaching an editable code view.
const isolate = (event: { stopPropagation(): void }) => event.stopPropagation();

export const ExampleAnnotation = memo(function ExampleAnnotation({
  messages,
  children,
  onSelect,
  onDelete,
  onDeleteMessage,
  onResolve,
}: ExampleAnnotationProps) {
  return (
    <div
      role="article"
      className={cn(
        annotationCardBase,
        'group relative flex-col hover:border-[var(--diffshub-annotation-hover-border,var(--diffshub-annotation-border,var(--color-border)))]'
      )}
      onKeyDown={isolate}
      onPointerDown={isolate}
      onMouseDown={isolate}
    >
      <Button
        variant="default"
        size="icon-sm"
        aria-label="Resolve conversation"
        onClick={onResolve}
        className={cn(cornerButton, 'right-0 translate-x-[-85%]')}
      >
        <IconCheck size={12} />
      </Button>
      <Button
        variant="default"
        size="icon-sm"
        aria-label="Delete conversation"
        onClick={onDelete}
        className={cn(cornerButton, 'right-0 translate-x-[35%]')}
      >
        <IconX size={12} />
      </Button>
      {messages.map((message, index) => (
        <div
          key={message.id}
          role={index === 0 ? 'button' : undefined}
          tabIndex={index === 0 ? 0 : undefined}
          aria-expanded={index === 0 ? true : undefined}
          className={cn('group/message flex gap-2.5', index === 0 && 'cursor-pointer')}
          onClick={index === 0 ? onSelect : undefined}
          onKeyDown={
            index === 0
              ? (event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') {
                    return;
                  }
                  event.preventDefault();
                  onSelect();
                }
              : undefined
          }
        >
          <AuthorInitial name={message.author} agent={message.agent} />
          <div className="flex min-w-0 flex-col">
            <div className="mt-1 flex items-center gap-1">
              <strong className="block text-[14px]">{message.author}</strong>
              {messages.length > 1 && (
                <span className="contents" onClick={isolate} onKeyDown={isolate}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`More actions for ${message.author}'s comment`}
                        className="size-5 text-muted-foreground opacity-0 group-hover/message:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                      >
                        <IconEllipsis size={12} />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuItem onSelect={() => onDeleteMessage(message.id)}>Delete</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </span>
              )}
            </div>
            <p className="m-0 text-[14px] break-words whitespace-pre-wrap">
              {message.message}
            </p>
          </div>
        </div>
      ))}
      {children}
    </div>
  );
});
