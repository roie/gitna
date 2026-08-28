/// <reference types="node" />

import { request as httpRequest } from 'node:http'
import { test, expect, type GitnaFixture } from './fixtures.js'

function localURL(app: GitnaFixture, path: string): string {
  const target = new URL(path, app.url)
  if (
    target.protocol !== 'http:' ||
    target.hostname !== '127.0.0.1' ||
    target.origin !== app.origin
  ) {
    throw new Error(`refusing non-local test URL: ${target.origin}`)
  }
  return target.href
}

function requestWithHost(
  app: GitnaFixture,
  host: string,
): Promise<{ status: number; location?: string }> {
  const target = new URL('api/v1/snapshot', app.url)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'GET',
        headers: { Host: host },
      },
      (response) => {
        response.resume()
        response.once('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            location: response.headers.location,
          }),
        )
      },
    )
    req.once('error', reject)
    req.end()
  })
}

test('capability and Host boundaries protect the real process', async ({ request, app }) => {
  const invalid = await request.get(localURL(app, '/g/not-the-token/api/v1/snapshot'))
  expect(invalid.status()).toBe(404)

  const hostileHost = await requestWithHost(app, 'attacker.invalid')
  expect(hostileHost.status).toBe(403)
  expect(hostileHost.location).toBeUndefined()
  expect(JSON.stringify(hostileHost)).not.toContain(app.token)

  const valid = await request.get(localURL(app, 'api/v1/snapshot'))
  expect(valid.status()).toBe(200)
  expect(valid.headers()['content-security-policy']).toContain("default-src 'self'")
})

test('malformed operation bodies are rejected without crashing', async ({ request, app }) => {
  const headers = { 'Content-Type': 'application/json', Origin: app.origin }
  const operation = localURL(app, 'api/v1/operations?op=stage')
  const trailingValue = await request.fetch(operation, {
    method: 'POST',
    headers,
    data: '{"paths":["modified.txt"]}{"paths":["staged.txt"]}',
  })
  expect(trailingValue.status()).toBe(400)

  const malformedConflict = await request.post(localURL(app, 'api/v1/operations?op=resolve-ours'), {
    headers,
    data: { paths: [] },
  })
  expect(malformedConflict.status()).toBe(400)

  const stillAlive = await request.get(localURL(app, 'api/v1/snapshot'))
  expect(stillAlive.status()).toBe(200)
  const snapshot = (await stillAlive.json()) as { unstaged: Array<{ path: string }> }
  expect(snapshot.unstaged.some((change) => change.path === 'modified.txt')).toBe(true)
})
