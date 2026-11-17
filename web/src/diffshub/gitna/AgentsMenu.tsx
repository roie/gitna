import { useId, useState, useSyncExternalStore } from 'react'

import {
  AgentAuthRequired,
  type AddAgent,
  type AgentDefinition,
  type AgentSetup,
  type AuthMethod,
  type ConversationsModel,
  type FoundAgent,
  suggestName,
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

type Dialog = 'custom' | 'auth' | 'setup' | null

export function AgentsMenu({ model }: { model: ConversationsModel }) {
  useSyncExternalStore(
    (listener) => model.subscribe(listener),
    () => model.version,
  )
  const id = useId()
  const [menu, setMenu] = useState(false)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [definitions, setDefinitions] = useState<AgentDefinition[]>([])
  const [available, setAvailable] = useState<FoundAgent[]>([])
  const [setup, setSetup] = useState<AgentSetup[]>([])
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [busy, setBusy] = useState(false)
  const [connecting, setConnecting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [methods, setMethods] = useState<AuthMethod[]>([])
  const [pending, setPending] = useState<{ name: string; request: AddAgent } | null>(null)
  const [added, setAdded] = useState<AgentDefinition | null>(null)
  const refresh = async () => {
    const settings = await model.api.settings()
    setDefinitions(settings.agents)
    setAvailable(settings.available)
    setSetup(settings.setup)
  }
  const attempt = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (error) {
      if (error instanceof AgentAuthRequired) {
        setMethods(error.methods)
        setMenu(false)
        setDialog('auth')
      } else setError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  const connect = async (key: string, agentName: string, request: AddAgent) => {
    setPending({ name: agentName, request })
    setConnecting(key)
    let connected = false
    await attempt(async () => {
      const result = await model.addAgent(request)
      setAdded(result.definition)
      connected = true
      await refresh()
    })
    setConnecting(null)
    return connected
  }
  const openDialog = (next: Dialog) => {
    setError(null)
    setAdded(null)
    setDialog(next)
  }
  const known = [...available, ...setup]
  const suggestion = suggestName(command, known)
  const connected = new Set(model.agents.map((p) => p.agent))
  const saved = definitions.filter((d) => !connected.has(d.id))
  const needsAdapter = setup.filter((s) => s.adapterMissing)
  const hint = 'text-xs text-muted-foreground'
  return (
    <>
      <DropdownMenu
        open={menu}
        onOpenChange={(open) => {
          setMenu(open)
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
          {model.agents.length === 0 && (
            <p className={`m-0 px-2 py-1.5 ${hint}`}>No agents connected</p>
          )}
          {model.agents.map((p) => (
            <DropdownMenuItem
              key={p.id}
              aria-label={`Disconnect ${p.name}`}
              disabled={busy}
              className="justify-between gap-4"
              onSelect={(event) => {
                event.preventDefault()
                void attempt(() => model.leave(p.id))
              }}
            >
              <span className="min-w-0 truncate">
                {p.name}
                {p.agent == null && <span className={hint}> · CLI</span>}
              </span>
              <span className={hint}>Disconnect</span>
            </DropdownMenuItem>
          ))}
          {(saved.length > 0 || available.length > 0 || needsAdapter.length > 0) && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Available</DropdownMenuLabel>
              {saved.map((d) => (
                <DropdownMenuItem
                  key={d.id}
                  aria-label={`Connect ${d.name}`}
                  disabled={busy}
                  className="justify-between gap-4"
                  onSelect={(event) => {
                    event.preventDefault()
                    void connect(d.id, d.name, { definition: d.id })
                  }}
                >
                  <span className="min-w-0 truncate">{d.name}</span>
                  <span className={hint}>{connecting === d.id ? 'Connecting…' : 'Saved'}</span>
                </DropdownMenuItem>
              ))}
              {available.map((f) => (
                <DropdownMenuItem
                  key={f.executable}
                  aria-label={`Connect ${f.name}`}
                  disabled={busy}
                  className="justify-between gap-4"
                  onSelect={(event) => {
                    event.preventDefault()
                    void connect(f.executable, f.name, { name: f.name, command: f.command })
                  }}
                >
                  <span className="min-w-0 truncate">{f.name}</span>
                  <span className={hint}>
                    {connecting === f.executable ? 'Connecting…' : f.command}
                  </span>
                </DropdownMenuItem>
              ))}
              {needsAdapter.map((s) => (
                <DropdownMenuItem
                  key={s.command}
                  className="justify-between gap-4"
                  onSelect={() => openDialog('setup')}
                >
                  <span className="min-w-0 truncate">{s.name}</span>
                  <span className={hint}>Needs ACP adapter…</span>
                </DropdownMenuItem>
              ))}
              <p className={`m-0 max-w-72 px-2 py-1.5 ${hint}`}>
                Connected agents run as you and can change any file you can.
              </p>
            </>
          )}
          <DropdownMenuSeparator />
          {setup.length > 0 && (
            <DropdownMenuItem onSelect={() => openDialog('setup')}>
              Set up an agent…
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onSelect={() => {
              setName('')
              setCommand('')
              openDialog('custom')
            }}
          >
            Add custom agent…
          </DropdownMenuItem>
          {definitions.map((d) => (
            <DropdownMenuItem
              key={`forget-${d.id}`}
              disabled={busy}
              onSelect={(event) => {
                event.preventDefault()
                void attempt(async () => {
                  await model.api.deleteDefinition(d.id)
                  await refresh()
                })
              }}
            >
              Forget command for {d.name}
            </DropdownMenuItem>
          ))}
          {dialog == null && error != null && (
            <p role="alert" className="max-w-72 p-2 text-xs text-red-600">
              {error}
            </p>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog === 'auth' && pending != null && (
        <Modal title={`Sign in to ${pending.name}`} error={error} onClose={() => setDialog(null)}>
          <div className="flex flex-col gap-3">
            {methods.map((method) => (
              <div key={method.id} className="flex flex-col gap-2">
                <p className="m-0">
                  {method.name}
                  {method.description === '' ? '' : `: ${method.description}`}
                </p>
                {method.interactive ? (
                  <p className={`m-0 ${hint}`}>
                    Sign in by running the agent in a terminal, then try again.
                  </p>
                ) : (
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void connect('auth', pending.name, {
                        ...pending.request,
                        authMethod: method.id,
                      }).then((ok) => ok && setDialog(null))
                    }
                  >
                    {method.name}
                  </Button>
                )}
              </div>
            ))}
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void connect('auth', pending.name, pending.request).then(
                  (ok) => ok && setDialog(null),
                )
              }
            >
              {busy ? 'Checking agent…' : 'Try again'}
            </Button>
          </div>
        </Modal>
      )}
      {dialog === 'setup' && (
        <Modal title="Set up an agent" error={error} onClose={() => setDialog(null)}>
          <div className="flex flex-col gap-4">
            <p className={`m-0 ${hint}`}>
              Install an agent, then check again. Gitna looks for these programs on your PATH and
              never installs anything.
            </p>
            {[...needsAdapter, ...setup.filter((s) => !s.adapterMissing)].map((s) => (
              <section key={s.command} aria-label={s.name} className="flex flex-col gap-1">
                <h3 className="m-0 text-sm font-semibold">{s.name}</h3>
                {s.adapterMissing && (
                  <p className="m-0 text-sm">
                    Its CLI is installed, but the ACP adapter is missing.
                  </p>
                )}
                {s.install !== '' && (
                  <code className="break-all rounded bg-muted px-2 py-1 text-xs">{s.install}</code>
                )}
                <p className={`m-0 ${hint}`}>
                  Gitna starts <code>{s.command}</code>.{' '}
                  <a
                    href={s.website}
                    target="_blank"
                    rel="noreferrer"
                    className="underline underline-offset-4"
                  >
                    Installation guide
                  </a>
                </p>
              </section>
            ))}
            {available.length > 0 && (
              <p role="status" className="m-0 text-sm">
                Found {available.map((f) => f.name).join(', ')}. Connect from Agents.
              </p>
            )}
            <Button type="button" disabled={busy} onClick={() => void attempt(refresh)}>
              Check again
            </Button>
          </div>
        </Modal>
      )}
      {dialog === 'custom' && (
        <Modal title="Add custom agent" error={error} onClose={() => setDialog(null)}>
          {added == null ? (
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault()
                const agentName = name.trim() === '' ? suggestion : name
                void connect('custom', agentName, { name: agentName, command })
              }}
            >
              <p className="m-0 text-sm text-muted-foreground">
                An agent runs with your user's permissions. It can read and change anything you can,
                may act without asking, and may send repository content to its provider.
              </p>
              <div className="flex flex-col gap-1">
                <label htmlFor={`${id}-command`}>Command</label>
                <Input
                  id={`${id}-command`}
                  name="command"
                  required
                  autoFocus
                  value={command}
                  placeholder="my-agent --acp"
                  aria-describedby={`${id}-command-hint`}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(event) => setCommand(event.target.value)}
                />
                <p id={`${id}-command-hint`} className={`m-0 ${hint}`}>
                  The program and the option that starts it in ACP mode. Quote arguments that
                  contain spaces.
                </p>
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor={`${id}-name`}>Name</label>
                <Input
                  id={`${id}-name`}
                  name="name"
                  required={suggestion === ''}
                  maxLength={128}
                  value={name}
                  placeholder={suggestion}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
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
              <Button type="button" onClick={() => setDialog(null)}>
                Done
              </Button>
            </div>
          )}
        </Modal>
      )}
    </>
  )
}
