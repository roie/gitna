// Modified from the pinned DiffsHub donor: equivalent conditional ordering is
// normalized by Gitna's structural lint rule for standalone TypeScript.
export const COMMIT_HASH_METADATA_PATTERN = /^From\s+([a-f0-9]+)\s/im;

const commitPrefixEncoder = new TextEncoder();
const commitPrefixDecoder = new TextDecoder();

export function getPatchTreePathPrefix(
  patchMetadata: string | undefined,
  patchIndex: number
): string {
  const commitHash = patchMetadata?.match(COMMIT_HASH_METADATA_PATTERN)?.[1];
  return commitHash == null
    ? `Commit ${patchIndex + 1}`
    : detachCommitPrefix(commitHash.slice(0, 5));
}

function detachCommitPrefix(value: string): string {
  return commitPrefixDecoder.decode(commitPrefixEncoder.encode(value));
}
