import { afterEach, expect, it, vi } from 'vite-plus/test'
import { ApiError, createApi, type ApiClient } from '../src/lib/api'
import { GitnaRepository } from '../src/diffshub/gitna/repository'

afterEach(() => vi.unstubAllGlobals())

it('restores an approved draft as a dirty copy with its budget', async () => {
  const readWorktreeFile = vi
    .fn()
    .mockResolvedValue({ path: 'large.txt', content: 'disk', hash: 'baseline' })
  const repository = new GitnaRepository({ readWorktreeFile } as unknown as ApiClient)
  const path = await repository.restoreDraft({
    schema: 1,
    documentId: 'draft',
    clientId: 'client',
    label: 'large.txt',
    path: 'large.txt',
    revision: 1,
    contents: 'restored',
    baselineHash: 'baseline',
    maxBytes: 8388609,
    updatedAt: new Date().toISOString(),
  })
  expect(readWorktreeFile).toHaveBeenCalledWith('large.txt', 8388609)
  expect(repository.untitledDocument(path)).toMatchObject({ contents: 'restored', dirty: true })
  expect(repository.draftMaxBytes(path)).toBe(8388609)
})

it('keeps default requests bounded and sends consent budgets for read, save, create and backup', async () => {
  const fetch = vi.fn().mockImplementation(async () => new Response('{}'))
  vi.stubGlobal('fetch', fetch)
  const api = createApi('http://127.0.0.1:1234/g/token/folder/')
  await api.readWorktreeFile('large.txt')
  await api.readWorktreeFile('large.txt', 8388609)
  await api.writeWorktreeFile('large.txt', '😀', 'hash', 8388613)
  await api.createWorktreeFile('recovered.txt', '😀', 8388613)
  await api.putDraft!({
    schema: 1,
    documentId: 'id',
    clientId: 'client',
    label: 'large.txt',
    revision: 1,
    contents: '😀',
    maxBytes: 8388613,
    updatedAt: new Date().toISOString(),
  })
  expect(
    fetch.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('maxBytes')),
  ).toEqual([null, '8388609', '8388613', '8388613', '8388613'])
  expect(JSON.parse(fetch.mock.calls[2]![1].body)).toEqual({
    path: 'large.txt',
    content: '😀',
    expectedHash: 'hash',
  })
})

it('preserves a large-file warning size without treating validation errors as consent', async () => {
  vi.stubGlobal('fetch', async () =>
    Response.json(
      { error: 'too large', code: 'file-too-large', sizeBytes: 6371439 },
      { status: 413 },
    ),
  )
  await expect(createApi().readWorktreeFile('large.txt')).rejects.toMatchObject({
    code: 'file-too-large',
    sizeBytes: 6371439,
    status: 413,
  })
  vi.stubGlobal('fetch', async () =>
    Response.json({ error: 'invalid encoding', code: 'unsupported-encoding' }, { status: 415 }),
  )
  await expect(createApi().readWorktreeFile('large.txt', 6371439)).rejects.toBeInstanceOf(ApiError)
  await expect(createApi().readWorktreeFile('large.txt', 6371439)).rejects.toMatchObject({
    code: 'unsupported-encoding',
    sizeBytes: undefined,
  })
})
