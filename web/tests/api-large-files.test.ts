import { afterEach, expect, it, vi } from 'vite-plus/test'
import { ApiError, createApi, type ApiClient, type DraftRecord } from '../src/lib/api'
import { serializeDraft } from '../src/lib/draftSerialization'
import { GitnaRepository } from '../src/diffshub/gitna/repository'

vi.mock('../src/lib/draftSerialization', () => ({ serializeDraft: vi.fn() }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetAllMocks()
})

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
  const draft: DraftRecord = {
    schema: 1,
    documentId: 'id',
    clientId: 'client',
    label: 'large.txt',
    revision: 1,
    contents: '😀',
    maxBytes: 8388613,
    updatedAt: new Date().toISOString(),
  }
  const body = new Blob([JSON.stringify(draft)], { type: 'application/json' })
  vi.mocked(serializeDraft).mockResolvedValue({ body, maxBytes: draft.maxBytes })
  await api.putDraft!(draft)
  expect(serializeDraft).toHaveBeenCalledExactlyOnceWith(draft)
  expect(fetch.mock.calls[4]![1].body).toBe(body)
  expect(
    fetch.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('maxBytes')),
  ).toEqual([null, '8388609', '8388613', '8388613', '8388613'])
  expect(JSON.parse(fetch.mock.calls[2]![1].body)).toEqual({
    path: 'large.txt',
    content: '😀',
    expectedHash: 'hash',
  })
})

it('uses the serialized backup budget after UTF-8 growth without changing the draft', async () => {
  const draft: DraftRecord = {
    schema: 1,
    documentId: 'id',
    clientId: 'client',
    label: 'large.txt',
    revision: 1,
    contents: '😀',
    maxBytes: 1,
    updatedAt: '2026-01-01T00:00:00Z',
  }
  const body = new Blob([JSON.stringify({ ...draft, maxBytes: 4 })], {
    type: 'application/json',
  })
  vi.mocked(serializeDraft).mockResolvedValue({ body, maxBytes: 4 })
  const fetch = vi.fn().mockResolvedValue(Response.json({ ...draft, maxBytes: 4 }))
  vi.stubGlobal('fetch', fetch)
  await expect(createApi().putDraft!(draft)).resolves.toEqual({ ...draft, maxBytes: 4 })
  expect(serializeDraft).toHaveBeenCalledExactlyOnceWith(draft)
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    'api/v1/drafts?maxBytes=4',
    expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }),
  )
  expect(draft.maxBytes).toBe(1)
})

it('revalidates an unchanged file without parsing or replacing its cached contents', async () => {
  const cached = { path: 'large.txt', content: 'x'.repeat(6 << 20), hash: 'baseline' }
  const response = new Response(null, { status: 304 })
  const json = vi.spyOn(response, 'json')
  const fetch = vi.fn().mockResolvedValue(response)
  vi.stubGlobal('fetch', fetch)
  const file = await createApi().readWorktreeFile('large.txt', cached.content.length, cached)
  expect(file).toBe(cached)
  expect(json).not.toHaveBeenCalled()
  expect(fetch.mock.calls[0]![1].headers).toEqual({ 'If-None-Match': '"baseline"' })
  expect(String(fetch.mock.calls[0]![0])).toContain(`maxBytes=${cached.content.length}`)
})

it('loads external changes and still reports validation failures when a cached file exists', async () => {
  const cached = { path: 'large.txt', content: 'before', hash: 'baseline' }
  const changed = { ...cached, content: 'external edit', hash: 'changed' }
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(changed))
    .mockResolvedValueOnce(
      Response.json({ error: 'invalid encoding', code: 'unsupported-encoding' }, { status: 415 }),
    )
  vi.stubGlobal('fetch', fetch)
  const api = createApi()
  expect(await api.readWorktreeFile('large.txt', undefined, cached)).toEqual(changed)
  await expect(api.readWorktreeFile('large.txt', undefined, cached)).rejects.toMatchObject({
    code: 'unsupported-encoding',
  })
})

it('does not validate a path against another file’s cached contents', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(Response.json({ path: 'other.txt', content: 'other', hash: 'other' }))
  vi.stubGlobal('fetch', fetch)
  await createApi().readWorktreeFile('other.txt', undefined, {
    path: 'large.txt',
    content: 'before',
    hash: 'baseline',
  })
  expect(fetch.mock.calls[0]![1].headers).toBeUndefined()
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
