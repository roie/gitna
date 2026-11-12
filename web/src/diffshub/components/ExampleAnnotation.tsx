// Modified by Gitna: render a conversation's messages with real authors, add
// resolve beside delete, and accept a reply form as children.
import { IconCheck, IconX } from '@pierre/icons';
import { memo, type ReactNode } from 'react';

import { AuthorInitial } from './DraftAnnotation';
import { Button } from '@/components/Button';
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
          className={cn('flex gap-2.5', index === 0 && 'cursor-pointer')}
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
            <strong className="mt-1 block text-[14px]">{message.author}</strong>
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
