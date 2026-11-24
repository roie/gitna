'use client';

import { useLayoutEffect } from 'react';

// Modified by Gitna: resolve gutter detection outside the donor monorepo.
import { detectGutterSize } from '../lib/gutter-detector';

const SCROLLBARS_TO_MEASURE: string[] = ['cv', 'gitna'];

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
