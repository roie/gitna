import { describe, expect, it } from 'vite-plus/test'
import { readContentSearchStream } from '../src/lib/contentSearchStream'
import { ApiError } from '../src/lib/api'

const file = {
  path: 'a.txt',
  matches: [{ line: 1, column: 0, length: 2, excerpt: '😀', matchStart: 0, matchEnd: 2 }],
}
const frame = (results: unknown[], done = false, generation = 7) =>
  JSON.stringify({ generation, results, complete: done, truncated: false, done }) + '\n'
const response = (text: string) => new Response(new TextEncoder().encode(text))

describe('content search streaming', () => {
  it('publishes a batch before the producer can finish', async () => {
    let observed = false
    let finish: () => void
    const result = await readContentSearchStream(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(frame([file])))
            // The batch callback is the only operation that can finish this stream.
            finish = () => {
              controller.enqueue(new TextEncoder().encode(frame([], true)))
              controller.close()
            }
          },
        }),
      ),
      (batch) => {
        observed = true
        expect(batch.results).toEqual([file])
        finish()
      },
    )
    expect(observed).toBe(true)
    expect(result.results).toEqual([file])
    expect(result.complete).toBe(true)
  })
  it('decodes UTF-8 split inside a code point', async () => {
    const bytes = new TextEncoder().encode(frame([file]) + frame([], true))
    const emoji = bytes.indexOf(0xf0)
    const result = await readContentSearchStream(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes.slice(0, emoji + 2))
            controller.enqueue(bytes.slice(emoji + 2))
            controller.close()
          },
        }),
      ),
    )
    expect(result.results[0].matches[0].excerpt).toBe('😀')
  })
  it('rejects a changed generation', async () => {
    await expect(
      readContentSearchStream(response(frame([file]) + frame([], true, 8))),
    ).rejects.toThrow('Folder changed')
  })
  it('rejects a stream that ends without its terminal frame', async () => {
    await expect(readContentSearchStream(response(frame([file])))).rejects.toThrow(
      'before completion',
    )
  })
  it('rejects a terminal error instead of returning stale results', async () => {
    await expect(
      readContentSearchStream(
        response(frame([file]) + JSON.stringify({ done: true, error: 'invalidated' }) + '\n'),
      ),
    ).rejects.toThrow('invalidated')
  })
  it('preserves timeout status for the UI to retain partial results', async () => {
    const input =
      frame([file]) +
      JSON.stringify({ done: true, error: 'timed out', status: 504, code: 'search-timeout' }) +
      '\n'
    await expect(
      readContentSearchStream(
        response(input),
        undefined,
        (status, message, code) => new ApiError(status, message, code),
      ),
    ).rejects.toMatchObject({ status: 504, code: 'search-timeout' })
  })
  it('caps decoded transfer size and match count', async () => {
    await expect(
      readContentSearchStream(new Response(new Uint8Array((2 << 20) + 1))),
    ).rejects.toThrow('too large')
    await expect(
      readContentSearchStream(
        response(frame([{ ...file, matches: Array(2001).fill(file.matches[0]) }])),
      ),
    ).rejects.toThrow('too many matches')
  })
})
