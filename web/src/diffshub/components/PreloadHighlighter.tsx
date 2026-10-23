'use client';
import { canUseWASM, preloadHighlighter } from '@pierre/diffs';
import { useEffect } from 'react';

export function PreloadHighlighter() {
  useEffect(() => {
    void preloadHighlighter({
      themes: [
        'pierre-dark',
        'pierre-dark-soft',
        'pierre-light',
        'pierre-light-soft',
      ],
      langs: ['zig', 'rust', 'typescript', 'tsx', 'bash'],
      preferredHighlighter: canUseWASM() ? 'highlights' : 'shiki-js',
    });
  }, []);
  return null;
}
