import { useId, useState, useSyncExternalStore } from 'react'

import {
  AgentAuthRequired,
  type AddAgent,
  type AgentDefinition,
  type AuthMethod,
  type ConversationsModel,
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
import { Modal } from './Modal'

export function AgentsMenu({ model }: { model: ConversationsModel }) {
  useSyncExternalStore(
    (listener) => model.subscribe(listener),
    () => model.version,
  )
  const id = useId()
  const [definitions, setDefinitions] = useState<AgentDefinition[]>([])
  const [form, setForm] = useState(false)
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [methods, setMethods] = useState<AuthMethod[]>([])
  const [pending, setPending] = useState<AddAgent | null>(null)
  const [added, setAdded] = useState<AgentDefinition | null>(null)
  const refresh = async () => setDefinitions((await model.api.settings()).agents)
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
          {model.agents.length === 0 && <DropdownMenuLabel>No agents joined</DropdownMenuLabel>}
          {model.agents.map((p) => (
            <DropdownMenuItem
              key={p.id}
              disabled={busy}
              onSelect={() => void attempt(() => model.leave(p.id))}
            >
              {p.name} · {p.agent == null ? 'CLI' : 'Native'} · Remove
            </DropdownMenuItem>
          ))}
          {definitions
            .filter((d) => !model.agents.some((p) => p.agent === d.id))
            .map((d) => (
              <DropdownMenuItem
                key={d.id}
                disabled={busy}
                onSelect={() => {
                  setAdded(null)
                  void add({ definition: d.id })
                }}
              >
                Add {d.name}
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
          <DropdownMenuItem
            onSelect={() => {
              setError(null)
              setMethods([])
              setAdded(null)
              setForm(true)
            }}
          >
            Add agent…
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
