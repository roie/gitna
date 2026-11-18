import { appendFileSync, closeSync, existsSync, openSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const mode = process.argv[2] ?? 'reply'
let root = ''
let authed = false
let promptID
let permissionID
let active
const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
const reply = (id, result) => send({ id, result })
const text = (value) =>
  send({
    method: 'session/update',
    params: {
      sessionId: 'test',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } },
    },
  })
function finish(reason = 'end_turn') {
  if (active != null) {
    closeSync(active)
    unlinkSync(join(root, '.git', 'native-active'))
    active = undefined
  }
  reply(promptID, { stopReason: reason })
  promptID = undefined
}

createInterface({ input: process.stdin })
  .on('line', (line) => {
    const message = JSON.parse(line)
    switch (message.method) {
      case 'initialize':
        reply(message.id, {
          protocolVersion: 1,
          agentCapabilities: {},
          authMethods: mode === 'auth' ? [{ id: 'login', name: 'Sign in' }] : [],
        })
        break
      case 'authenticate':
        authed = true
        reply(message.id, {})
        break
      case 'session/new':
        if (mode === 'auth' && !authed) {
          send({ id: message.id, error: { code: -32000, message: 'Authentication required' } })
          break
        }
        root = message.params.cwd
        reply(message.id, { sessionId: 'test' })
        break
      case 'session/prompt':
        promptID = message.id
        if (mode === 'hang') break
        if (mode === 'fail-once' && !existsSync(join(root, '.git', 'failed-once'))) {
          appendFileSync(join(root, '.git', 'failed-once'), '')
          send({ id: promptID, error: { code: -32603, message: 'Model unavailable' } })
          promptID = undefined
          break
        }
        active = openSync(join(root, '.git', 'native-active'), 'wx')
        appendFileSync(join(root, '.git', 'native-runs'), `${mode}\n`)
        if (mode === 'permission') {
          permissionID = 'permission'
          send({
            id: permissionID,
            method: 'session/request_permission',
            params: {
              sessionId: 'test',
              toolCall: { toolCallId: 'edit', title: 'Change a file' },
              options: [
                { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
                { optionId: 'no', name: 'Deny', kind: 'reject_once' },
              ],
            },
          })
          break
        }
        setTimeout(() => {
          if (promptID == null) return
          if (mode === 'edit') {
            const path = join(root, 'modified.txt')
            appendFileSync(path, 'agent edit\n')
            text(`Edited modified.txt: ${readFileSync(path, 'utf8').trim()}`)
          } else text(`Reply from ${mode}`)
          finish()
        }, 500)
        break
      case 'session/cancel':
        if (promptID != null) finish('cancelled')
        break
      default:
        if (message.id === permissionID) {
          text(`Permission: ${message.result.outcome.optionId ?? 'cancelled'}`)
          finish()
        }
    }
  })
  .on('close', () => process.exit(0))
