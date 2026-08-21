'use client';
// Modified from the pinned DiffsHub donor: Gitna uses Shiki's JS engine so
// its strict CSP can remain free of wasm-unsafe-eval.
import { preloadHighlighter } from '@pierre/diffs';
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
      preferredHighlighter: 'shiki-js',
    });
  }, []);
  return null;
}
