import {
  IconAsterisk,
  IconBox,
  IconBrandCursor,
  IconBrandGithub,
  IconDownload,
  IconPlus,
  IconSparkle,
  IconTerminal,
  IconTrash,
  IconUnlink,
  IconX,
} from '@pierre/icons'
import { Fragment, useId, useState, useSyncExternalStore } from 'react'

import {
  AgentAuthRequired,
  type AddAgent,
  type AgentDefinition,
  type AgentModels,
  type AgentSetup,
  type AuthMethod,
  type ConversationsModel,
  type FoundAgent,
  type InstalledAdapter,
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

const PROGRAM_ICONS: Record<string, typeof IconTerminal> = {
  'claude-agent-acp': IconAsterisk,
  'codex-acp': IconBox,
  'cursor-agent': IconBrandCursor,
  gemini: IconSparkle,
  copilot: IconBrandGithub,
}

function AgentIcon({ row }: { row: Row }) {
  const executable = row.definition?.executable ?? row.found?.executable ?? row.setup?.program ?? ''
  const program = executable
    .split(/[\\/]/)
    .pop()!
    .replace(/\.(exe|cmd)$/i, '')
  const Icon = PROGRAM_ICONS[program] ?? IconTerminal
  return <Icon aria-hidden="true" className="size-4 shrink-0" />
}

type Dialog = 'custom' | 'auth' | 'setup' | 'confirm' | 'download' | 'remove' | 'model' | null

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
  const [adapters, setAdapters] = useState<InstalledAdapter[]>([])
  const [downloading, setDownloading] = useState<{ key: string; percent: number | null } | null>(
    null,
  )
  const [downloadFor, setDownloadFor] = useState<AgentSetup | null>(null)
  const [removing, setRemoving] = useState<{ row: Row; adapter: InstalledAdapter } | null>(null)
  const [modelFor, setModelFor] = useState<AgentDefinition | null>(null)
  const [models, setModels] = useState<AgentModels | null>(null)
  const [chosen, setChosen] = useState('')
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
    setAdapters(settings.adapters)
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
    downloading?.key === row.key
      ? downloading.percent == null
        ? 'Downloading…'
        : `Downloading ${downloading.percent}%`
      : connecting === row.key
        ? 'Connecting…'
        : failed === row.key
          ? "Couldn't connect"
          : row.participant != null
            ? 'Connected'
            : row.setup?.download?.requiresNode
              ? 'Requires Node.js'
              : ''
  const select = (row: Row) => {
    if (row.participant != null) setExpanded(expanded === row.key ? null : row.key)
    else if (row.definition != null)
      void connect(row.key, row.name, { definition: row.definition.id })
    else if (row.found != null) {
      setConfirming(row.found)
      setMenu(false)
      openDialog('confirm')
    } else if (row.setup?.download != null && !row.setup.download.requiresNode) {
      setDownloadFor(row.setup)
      setMenu(false)
      openDialog('download')
    } else {
      setMenu(false)
      openDialog('setup')
    }
  }
  const install = (s: AgentSetup) =>
    attempt(async () => {
      setDownloading({ key: s.command, percent: s.download?.source.startsWith('npm ') ? null : 0 })
      try {
        const found = await model.api.installAdapter(s.program, (percent) =>
          setDownloading({ key: s.command, percent }),
        )
        setDownloading(null)
        if (await connect(s.command, found.name, { name: found.name, command: found.command }))
          setDialog(null)
      } finally {
        setDownloading(null)
      }
    })
  const adapterOf = (row: Row) =>
    adapters.find((a) => {
      const path = row.definition?.executable ?? ''
      return path.startsWith(a.folder) && /[\\/]/.test(path.charAt(a.folder.length))
    })
  const chooseModel = async (definition: AgentDefinition) => {
    setModelFor(definition)
    setModels(null)
    setMenu(false)
    openDialog('model')
    setBusy(true)
    try {
      const listed = await model.api.agentModels(definition.id)
      setModels(listed)
      setChosen(listed.model)
    } catch (error) {
      setError(
        error instanceof AgentAuthRequired
          ? `Sign in to ${definition.name} first, then try again.`
          : error instanceof Error
            ? error.message
            : String(error),
      )
    } finally {
      setBusy(false)
    }
  }
  const megabytes = (size: number) => `${Math.round(size / 1e6)} MB`
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
                <span className="flex min-w-0 items-center gap-2">
                  <AgentIcon row={row} />
                  <span className="truncate">{row.name}</span>
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
                    className="gap-2 pl-6"
                    onSelect={(event) => {
                      event.preventDefault()
                      const participant = row.participant!.id
                      void attempt(async () => {
                        await model.leave(participant)
                        setExpanded(null)
                      })
                    }}
                  >
                    <IconUnlink aria-hidden="true" className="size-4" />
                    Disconnect
                  </DropdownMenuItem>
                  {row.definition != null && (
                    <DropdownMenuItem
                      aria-label={`Model for ${row.name}`}
                      disabled={busy}
                      className="gap-2 pl-6"
                      onSelect={() => void chooseModel(row.definition!)}
                    >
                      <IconBox aria-hidden="true" className="size-4" />
                      Model…
                    </DropdownMenuItem>
                  )}
                  {adapterOf(row) != null && (
                    <DropdownMenuItem
                      aria-label={`Remove ${row.name} adapter`}
                      disabled={busy}
                      className="gap-2 pl-6"
                      onSelect={() => {
                        setRemoving({ row, adapter: adapterOf(row)! })
                        openDialog('remove')
                      }}
                    >
                      <IconTrash aria-hidden="true" className="size-4" />
                      Remove adapter
                    </DropdownMenuItem>
                  )}
                  {row.definition != null && (
                    <DropdownMenuItem
                      aria-label={`Forget ${row.name}`}
                      disabled={busy}
                      className="gap-2 pl-6"
                      onSelect={(event) => {
                        event.preventDefault()
                        void forget(row)
                      }}
                    >
                      <IconX aria-hidden="true" className="size-4" />
                      Forget
                    </DropdownMenuItem>
                  )}
                </>
              )}
            </Fragment>
          ))}
          <DropdownMenuSeparator />
          {setup.length > 0 && (
            <DropdownMenuItem className="gap-2" onSelect={() => openDialog('setup')}>
              <IconDownload aria-hidden="true" className="size-4" />
              More agents…
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            className="gap-2"
            onSelect={() => {
              setName('')
              setCommand('')
              openDialog('custom')
            }}
          >
            <IconPlus aria-hidden="true" className="size-4" />
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
      {dialog === 'download' && downloadFor?.download != null && (
        <Modal title={`Connect ${downloadFor.name}`} error={error} onClose={() => setDialog(null)}>
          <div className="flex flex-col gap-3">
            <p className="m-0 text-sm text-muted-foreground">
              {downloadFor.name} runs with your user's permissions. It can read and change anything
              you can, may act without asking, and may send repository content to its provider. Once
              connected, it is available in every repository and runs only when a message names it.
            </p>
            <p className="m-0 text-sm">Gitna first downloads its ACP adapter once:</p>
            <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Source</dt>
              <dd className="m-0 break-all">{downloadFor.download.source}</dd>
              <dt className="text-muted-foreground">Version</dt>
              <dd className="m-0">{downloadFor.download.version}</dd>
              <dt className="text-muted-foreground">Size</dt>
              <dd className="m-0">
                {downloadFor.download.source.startsWith('npm ')
                  ? `About ${megabytes(downloadFor.download.size)} installed`
                  : `${megabytes(downloadFor.download.size)} download`}
              </dd>
              <dt className="text-muted-foreground">Folder</dt>
              <dd className="m-0 break-all">{downloadFor.download.folder}</dd>
            </dl>
            <Button type="button" disabled={busy} onClick={() => void install(downloadFor)}>
              {downloading != null
                ? status({ key: downloadFor.command, name: downloadFor.name })
                : busy
                  ? 'Connecting…'
                  : 'Download and connect'}
            </Button>
          </div>
        </Modal>
      )}
      {dialog === 'remove' && removing != null && (
        <Modal
          title={`Remove ${removing.row.name} adapter`}
          error={error}
          onClose={() => setDialog(null)}
        >
          <div className="flex flex-col gap-3">
            <p className="m-0 text-sm">
              This frees {megabytes(removing.adapter.size)} and forgets {removing.row.name} in every
              repository.
            </p>
            <Button
              type="button"
              disabled={busy}
              onClick={() =>
                void attempt(async () => {
                  if (removing.row.participant != null)
                    await model.leave(removing.row.participant.id)
                  await model.api.removeAdapter(removing.adapter.program)
                  setExpanded(null)
                  await refresh()
                  setDialog(null)
                })
              }
            >
              Remove adapter
            </Button>
          </div>
        </Modal>
      )}
      {dialog === 'model' && modelFor != null && (
        <Modal title={`Model for ${modelFor.name}`} error={error} onClose={() => setDialog(null)}>
          {models == null ? (
            error == null && (
              <p role="status" className="m-0 text-sm text-muted-foreground">
                Starting {modelFor.name} to list its models…
              </p>
            )
          ) : (
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault()
                void attempt(async () => {
                  await model.api.setAgentModel(modelFor.id, chosen)
                  setDialog(null)
                })
              }}
            >
              <label htmlFor={`${id}-model`} className="grid gap-1 text-sm">
                Model
                <select
                  id={`${id}-model`}
                  className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                  value={chosen}
                  onChange={(event) => setChosen(event.currentTarget.value)}
                >
                  <option value="">
                    Agent default (
                    {models.options.find((m) => m.id === models.default)?.name ?? models.default})
                  </option>
                  {models.options.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
              <p className={`m-0 ${hint}`}>Applies to every run of {modelFor.name}.</p>
              <Button type="submit" disabled={busy}>
                Save
              </Button>
            </form>
          )}
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
              Install an agent, then check again. Gitna looks for these programs on your PATH.
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
