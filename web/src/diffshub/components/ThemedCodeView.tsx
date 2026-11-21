'use client';

import {
  CodeView,
  type CodeViewHandle,
  type CodeViewProps,
} from '@pierre/diffs/react';
import { type Ref, useMemo } from 'react';

import { useDiffTheme } from '../gitna/useDiffTheme';

type ThemedCodeViewComponent = <LAnnotation = undefined>(
  props: CodeViewProps<LAnnotation, undefined> & {
    ref?: Ref<CodeViewHandle<LAnnotation, undefined>>;
  }
) => React.JSX.Element;

export const ThemedCodeView: ThemedCodeViewComponent = <
  LAnnotation = undefined,
>({
  disableWorkerPool = false,
  options,
  ref,
  ...props
}: CodeViewProps<LAnnotation, undefined> & {
  ref?: Ref<CodeViewHandle<LAnnotation, undefined>>;
}): React.JSX.Element => {
  const diffTheme = useDiffTheme();
  const workerPoolDisabled = disableWorkerPool || diffTheme.workersFailed;
  const themedOptions = useMemo(
    () => ({
      ...options,
      theme: diffTheme.theme,
      themeType: options?.themeType ?? diffTheme.themeType,
    }),
    [diffTheme.theme, diffTheme.themeType, options]
  );
  return (
    <CodeView<LAnnotation, undefined>
      {...props}
      ref={ref}
      key={workerPoolDisabled ? 'main-thread' : 'workers'}
      disableWorkerPool={workerPoolDisabled}
      options={themedOptions}
    />
  );
};
