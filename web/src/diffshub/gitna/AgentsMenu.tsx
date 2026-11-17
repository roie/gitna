import { useId, useState, useSyncExternalStore } from 'react'

import {
  AgentAuthRequired,
  type AddAgent,
  type AgentDefinition,
  type AuthMethod,
  type ConversationsModel,
  type FoundAgent,
  type Participant,
} from '../../lib/conversations'
import { Button } from '../components/Button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/DropdownMenu'
import { Input } from '../components/Input'
import { Switch } from '../components/Switch'
import { Modal } from './Modal'

interface AgentRow {
  key: string
  name: string
  participant?: Participant
  definition?: AgentDefinition
  found?: FoundAgent
}

export function AgentsMenu({ model }: { model: ConversationsModel }) {
  useSyncExternalStore(
    (listener) => model.subscribe(listener),
    () => model.version,
  )
  const id = useId()
  const [definitions, setDefinitions] = useState<AgentDefinition[]>([])
  const [available, setAvailable] = useState<FoundAgent[]>([])
  const [form, setForm] = useState(false)
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [methods, setMethods] = useState<AuthMethod[]>([])
  const [pending, setPending] = useState<AddAgent | null>(null)
  const [added, setAdded] = useState<AgentDefinition | null>(null)
  const [checking, setChecking] = useState<string | null>(null)
  const refresh = async () => {
    const settings = await model.api.settings()
    setDefinitions(settings.agents)
    setAvailable(settings.available)
  }
  const open = (agent: { name: string; command: string }) => {
    setName(agent.name)
    setCommand(agent.command)
    setError(null)
    setMethods([])
    setAdded(null)
    setForm(true)
  }
  const attempt = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (error) {
      if (error instanceof AgentAuthRequired) {
        setMethods(error.methods)
        setForm(true)
      } else setError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  const add = (request: AddAgent) =>
    attempt(async () => {
      setPending(request)
      const result = await model.addAgent(request)
      setAdded(result.definition)
      setMethods([])
      await refresh()
    })
  const native = model.agents.filter((p) => p.agent != null)
  const rows: AgentRow[] = [
    ...definitions.map((d) => {
      const participant = native.find((p) => p.agent === d.id)
      return { key: d.id, name: participant?.name ?? d.name, participant, definition: d }
    }),
    ...native
      .filter((p) => !definitions.some((d) => d.id === p.agent))
      .map((p) => ({ key: p.id, name: p.name, participant: p })),
    ...available.map((f) => ({ key: f.executable, name: f.name, found: f })),
  ]
  const toggle = (row: AgentRow) => {
    if (row.participant != null) {
      const id = row.participant.id
      void attempt(() => model.leave(id))
    } else if (row.definition != null) {
      setChecking(row.key)
      void add({ definition: row.definition.id }).finally(() => setChecking(null))
    } else if (row.found != null) open(row.found)
  }
  return (
    <>
      <DropdownMenu
        onOpenChange={(open) => {
          if (open) void attempt(refresh)
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="sm">
            Agents
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-w-[calc(100vw-2rem)]">
          <DropdownMenuLabel>In this repository</DropdownMenuLabel>
          {rows.length === 0 && model.agents.length === 0 && (
            <DropdownMenuLabel>No agents found</DropdownMenuLabel>
          )}
          {rows.map((row) => (
            <DropdownMenuItem
              key={row.key}
              role="menuitemcheckbox"
              aria-checked={row.participant != null}
              disabled={busy}
              className="justify-between gap-4"
              onSelect={(event) => {
                if (row.found == null) event.preventDefault()
                toggle(row)
              }}
            >
              <span className="min-w-0 flex-1 truncate">{row.name}</span>
              {checking === row.key && (
                <span className="text-xs text-muted-foreground">Checking…</span>
              )}
              <Switch
                aria-hidden
                tabIndex={-1}
                checked={row.participant != null}
                className="pointer-events-none"
              />
            </DropdownMenuItem>
          ))}
          {model.agents
            .filter((p) => p.agent == null)
            .map((p) => (
              <DropdownMenuItem
                key={p.id}
                disabled={busy}
                onSelect={() => void attempt(() => model.leave(p.id))}
              >
                {p.name} · CLI · Remove
              </DropdownMenuItem>
            ))}
          {definitions.map((d) => (
            <DropdownMenuItem
              key={`forget-${d.id}`}
              disabled={busy}
              onSelect={() =>
                void attempt(async () => {
                  await model.api.deleteDefinition(d.id)
                  await refresh()
                })
              }
            >
              Forget command for {d.name}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => open({ name: '', command: '' })}>
            Add custom agent…
          </DropdownMenuItem>
          {!form && error != null && (
            <p role="alert" className="max-w-72 p-2 text-xs text-red-600">
              {error}
            </p>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {form && (
        <Modal title="Add agent" error={error} onClose={() => setForm(false)}>
          {added == null ? (
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault()
                void add({ name, command })
              }}
            >
              <p className="m-0 text-sm text-muted-foreground">
                An agent runs with your user's permissions. It can read and change anything you can,
                may act without asking, and may send repository content to its provider.
              </p>
              <div className="flex flex-col gap-1">
                <label htmlFor={`${id}-name`}>Name</label>
                <Input
                  id={`${id}-name`}
                  name="name"
                  required
                  maxLength={128}
                  autoFocus
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor={`${id}-command`}>Command</label>
                <Input
                  id={`${id}-command`}
                  name="command"
                  required
                  value={command}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(event) => setCommand(event.target.value)}
                />
              </div>
              {methods.map((method) => (
                <div key={method.id} className="flex flex-col gap-2">
                  <p>
                    {method.name}
                    {method.description === '' ? '' : `: ${method.description}`}
                  </p>
                  {method.interactive ? (
                    <p>Sign in outside Gitna, then try again.</p>
                  ) : (
                    <Button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (pending != null) void add({ ...pending, authMethod: method.id })
                      }}
                    >
                      {method.name}
                    </Button>
                  )}
                </div>
              ))}
              <Button type="submit" disabled={busy}>
                {busy ? 'Checking agent…' : 'Add agent'}
              </Button>
            </form>
          ) : (
            <div className="flex flex-col gap-3">
              <p role="status">Added {added.name}</p>
              <code className="whitespace-pre-wrap break-all">
                {JSON.stringify([added.executable, ...added.args])}
              </code>
              <Button type="button" onClick={() => setForm(false)}>
                Done
              </Button>
            </div>
          )}
        </Modal>
      )}
    </>
  )
}
