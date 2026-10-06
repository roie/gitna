import type { ContentSearchResults } from './types'

type SearchFrame = ContentSearchResults & {
  done: boolean
  error?: string
  status?: number
  code?: string
}

export async function readContentSearchStream(
  response: Response,
  onBatch?: (result: ContentSearchResults) => void,
  errorFactory?: (status: number, message: string, code?: string) => Error,
): Promise<ContentSearchResults> {
  if (response.body == null) throw new Error('Content search response has no body.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const results: ContentSearchResults['results'] = []
  let buffered = ''
  let bytes = 0
  let matches = 0
  let generation: number | undefined
  try {
    for (;;) {
      const { value, done } = await reader.read()
      bytes += value?.byteLength ?? 0
      if (bytes > 2 << 20) throw new Error('Content search response is too large.')
      buffered += decoder.decode(value, { stream: !done })
      let newline: number
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        if (!line) continue
        const frame = JSON.parse(line) as SearchFrame
        if (frame.error)
          throw (
            errorFactory?.(frame.status ?? 500, frame.error, frame.code) ?? new Error(frame.error)
          )
        if (!Array.isArray(frame.results)) throw new Error('Invalid content search response.')
        generation ??= frame.generation
        if (frame.generation !== generation) throw new Error('Folder changed while searching.')
        for (const file of frame.results) matches += file.matches.length
        if (matches > 2000) throw new Error('Content search returned too many matches.')
        results.push(...frame.results)
        const result = {
          generation,
          results: results.slice(),
          complete: frame.complete,
          truncated: frame.truncated,
          skippedLargeFiles: frame.skippedLargeFiles ?? 0,
          skippedLongLines: frame.skippedLongLines ?? 0,
        }
        if (frame.done) return result
        onBatch?.(result)
      }
      if (done) throw new Error('Content search ended before completion.')
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
