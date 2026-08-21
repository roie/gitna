'use client';

import { useLayoutEffect } from 'react';

// Modified from the pinned DiffsHub donor: use a relative import so this
// standalone Vite boundary remains resolvable outside the donor monorepo.
import { detectGutterSize } from '../lib/gutterDetector';

const SCROLLBARS_TO_MEASURE: string[] = ['cv', 'cv-mini'];

export function ScrollbarGutterVariables() {
  useLayoutEffect(() => {
    const { documentElement: root } = document;
    for (const prefix of SCROLLBARS_TO_MEASURE) {
      const size = detectGutterSize(`${prefix}-scrollbar`);
      root.style.setProperty(
        `--${prefix}-gutter-vertical`,
        `${size.vertical}px`
      );
      root.style.setProperty(
        `--${prefix}-gutter-horizontal`,
        `${size.horizontal}px`
      );
    }
  }, []);

  return null;
}
