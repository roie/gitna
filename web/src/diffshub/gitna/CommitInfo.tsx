import { useState } from 'react'
import { useLoadingIndicator } from '../lib/loading'
import type { CommitStats, GraphCommit } from '../../lib/types'

function relativeCommitTime(value: string): string {
  const elapsedSeconds = Math.round((new Date(value).getTime() - Date.now()) / 1000)
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ]
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  for (const [unit, seconds] of units) {
    if (Math.abs(elapsedSeconds) >= seconds) {
      return formatter.format(Math.round(elapsedSeconds / seconds), unit)
    }
  }
  return formatter.format(elapsedSeconds, 'second')
}

export function CommitInfo({
  commit,
  stats,
  error,
}: {
  commit: Pick<GraphCommit, 'oid' | 'subject' | 'authorName' | 'authorTime' | 'refs'>
  stats?: CommitStats
  error?: string
}) {
  const [commitOidCopied, setCommitOidCopied] = useState(false)
  const loadingVisible = useLoadingIndicator(stats == null && error == null, commit.oid)
  const shortOid = commit.oid.slice(0, 8)
  const authorTime = new Date(commit.authorTime)
  const refs = commit.refs.filter(
    (ref, index, all) => all.findIndex((candidate) => candidate.name === ref.name) === index,
  )
  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
        <strong className="font-medium">{commit.authorName}</strong>
        <span className="text-muted-foreground">
          {relativeCommitTime(commit.authorTime)} ({authorTime.toLocaleString()})
        </span>
      </div>
      <p className="mt-2 font-medium">
        {commit.subject.trim() || `No commit message (${commit.oid.slice(0, 7)})`}
      </p>
      {refs.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {refs.map((ref) => (
            <span
              key={`${ref.kind}:${ref.name}`}
              className="rounded-full border border-border px-1.5 py-0.5 text-[10px]"
            >
              {ref.name}
            </span>
          ))}
        </div>
      )}
      <div className="mt-2 flex items-center gap-2 border-t border-border pt-2 text-[11px]">
        {stats == null ? (
          <span className="text-muted-foreground">
            {error ?? (loadingVisible ? 'Loading statistics…' : null)}
          </span>
        ) : (
          <>
            <span className="text-muted-foreground">
              {stats.files} {stats.files === 1 ? 'file' : 'files'}
            </span>
            <span className="font-medium text-emerald-600 dark:text-emerald-400">
              +{stats.additions}
            </span>
            <span className="font-medium text-red-600 dark:text-red-400">−{stats.deletions}</span>
            {stats.binaryFiles > 0 && (
              <span className="text-muted-foreground">
                {stats.binaryFiles} {stats.binaryFiles === 1 ? 'binary' : 'binaries'}
              </span>
            )}
          </>
        )}
        <button
          type="button"
          className="ml-auto cursor-pointer rounded-sm px-1 font-mono text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label={
            commitOidCopied ? `Copied commit ID ${shortOid}` : `Copy commit ID ${shortOid}`
          }
          aria-live="polite"
          title="Copy full commit ID"
          onClick={() => {
            void navigator.clipboard
              .writeText(commit.oid)
              .then(() => {
                setCommitOidCopied(true)
                window.setTimeout(() => setCommitOidCopied(false), 1500)
              })
              .catch(() => undefined)
          }}
        >
          {commitOidCopied ? 'Copied!' : shortOid}
        </button>
      </div>
    </>
  )
}
