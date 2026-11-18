import { Fragment, useId, useState, useSyncExternalStore } from 'react'

import {
  AgentAuthRequired,
  type AddAgent,
  type AgentDefinition,
  type AgentSetup,
  type AuthMethod,
  type ConversationsModel,
  type FoundAgent,
  type Participant,
  suggestName,
} from '../../lib/conversations'
import { Button } from '../components/Button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/DropdownMenu'
import { Input } from '../components/Input'
import { Modal } from './Modal'

type Dialog = 'custom' | 'auth' | 'setup' | 'confirm' | null

interface Row {
  key: string
  name: string
  participant?: Participant
  definition?: AgentDefinition
  found?: FoundAgent
  setup?: AgentSetup
}

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
  const [failed, setFailed] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<FoundAgent | null>(null)
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
      return true
    } catch (error) {
      if (error instanceof AgentAuthRequired) {
        setMethods(error.methods)
        setMenu(false)
        setDialog('auth')
      } else setError(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      setBusy(false)
    }
  }
  const connect = async (key: string, agentName: string, request: AddAgent) => {
    setPending({ name: agentName, request })
    setConnecting(key)
    setFailed(null)
    const connected = await attempt(async () => {
      const result = await model.addAgent(request)
      setAdded(result.definition)
      await refresh()
    })
    setConnecting(null)
    if (!connected) setFailed(key)
    return connected
  }
  const openDialog = (next: Dialog) => {
    setError(null)
    setAdded(null)
    setDialog(next)
  }
  const known = [...available, ...setup]
  const suggestion = suggestName(command, known)
  const joined = new Set(model.agents.map((p) => p.agent))
  const rows: Row[] = [
    ...model.agents.map((p) => ({
      key: p.id,
      name: p.name,
      participant: p,
      definition: definitions.find((d) => d.id === p.agent),
    })),
    ...definitions
      .filter((d) => !joined.has(d.id))
      .map((d) => ({ key: d.id, name: d.name, definition: d })),
    ...available.map((f) => ({ key: f.executable, name: f.name, found: f })),
    ...setup
      .filter((s) => s.adapterMissing)
      .map((s) => ({ key: s.command, name: s.name, setup: s })),
  ]
  const status = (row: Row) =>
    connecting === row.key
      ? 'Connecting…'
      : failed === row.key
        ? "Couldn't connect"
        : row.participant != null
          ? 'Connected'
          : row.setup != null
            ? 'Set up'
            : ''
  const select = (row: Row) => {
    if (row.participant != null) setExpanded(expanded === row.key ? null : row.key)
    else if (row.definition != null)
      void connect(row.key, row.name, { definition: row.definition.id })
    else if (row.found != null) {
      setConfirming(row.found)
      setMenu(false)
      openDialog('confirm')
    } else {
      setMenu(false)
      openDialog('setup')
    }
  }
  const forget = (row: Row) =>
    attempt(async () => {
      if (row.participant != null) await model.leave(row.participant.id)
      if (row.definition != null) await model.api.deleteDefinition(row.definition.id)
      setExpanded(null)
      await refresh()
    })
  const hint = 'text-xs text-muted-foreground'
  return (
    <>
      <DropdownMenu
        open={menu}
        onOpenChange={(open) => {
          setMenu(open)
          setExpanded(null)
          if (open) void attempt(refresh)
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="sm">
            Agents
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56 max-w-[calc(100vw-2rem)]">
          {rows.length === 0 && <p className={`m-0 px-2 py-1.5 ${hint}`}>No agents found</p>}
          {rows.map((row) => (
            <Fragment key={row.key}>
              <DropdownMenuItem
                disabled={busy}
                aria-expanded={row.participant != null ? expanded === row.key : undefined}
                className="justify-between gap-4"
                onSelect={(event) => {
                  if (row.found == null && row.setup == null) event.preventDefault()
                  select(row)
                }}
              >
                <span className="min-w-0 truncate">
                  {row.name}
                  {row.participant != null && row.participant.agent == null && (
                    <span className={hint}> · CLI</span>
                  )}
                </span>
                <span className={hint}>{status(row)}</span>
              </DropdownMenuItem>
              {expanded === row.key && row.participant != null && (
                <>
                  <DropdownMenuItem
                    aria-label={`Disconnect ${row.name}`}
                    disabled={busy}
                    className="pl-6"
                    onSelect={(event) => {
                      event.preventDefault()
                      const participant = row.participant!.id
                      void attempt(async () => {
                        await model.leave(participant)
                        setExpanded(null)
                      })
                    }}
                  >
                    Disconnect
                  </DropdownMenuItem>
                  {row.definition != null && (
                    <DropdownMenuItem
                      aria-label={`Forget ${row.name}`}
                      disabled={busy}
                      className="pl-6"
                      onSelect={(event) => {
                        event.preventDefault()
                        void forget(row)
                      }}
                    >
                      Forget
                    </DropdownMenuItem>
                  )}
                </>
              )}
            </Fragment>
          ))}
          <DropdownMenuSeparator />
          {setup.length > 0 && (
            <DropdownMenuItem onSelect={() => openDialog('setup')}>More agents…</DropdownMenuItem>
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
          {dialog == null && error != null && (
            <p role="alert" className="max-w-72 p-2 text-xs text-red-600">
              {error}
            </p>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog === 'confirm' && confirming != null && (
        <Modal title={`Connect ${confirming.name}`} error={error} onClose={() => setDialog(null)}>
          <div className="flex flex-col gap-3">
            <p className="m-0 text-sm text-muted-foreground">
              {confirming.name} runs with your user's permissions. It can read and change anything
              you can, may act without asking, and may send repository content to its provider. Once
              connected, it is available in every repository and runs only when a message names it.
            </p>
            <p className="m-0 text-sm">
              Gitna runs <code className="break-all">{confirming.command}</code>
            </p>
            <Button
              type="button"
              disabled={busy}
              onClick={() =>
                void connect(confirming.executable, confirming.name, {
                  name: confirming.name,
                  command: confirming.command,
                }).then((ok) => ok && setDialog(null))
              }
            >
              {busy ? 'Connecting…' : 'Connect'}
            </Button>
          </div>
        </Modal>
      )}
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
        <Modal title="More agents" error={error} onClose={() => setDialog(null)}>
          <div className="flex flex-col gap-4">
            <p className={`m-0 ${hint}`}>
              Install an agent, then check again. Gitna looks for these programs on your PATH and
              never installs anything.
            </p>
            {[
              ...setup.filter((s) => s.adapterMissing),
              ...setup.filter((s) => !s.adapterMissing),
            ].map((s) => (
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
