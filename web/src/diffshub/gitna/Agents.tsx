import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import {
  IconBox,
  IconCheck,
  IconChevronSm,
  IconDownload,
  IconEllipsis,
  IconPencil,
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
  type AgentSetup,
  type AuthMethod,
  type ConversationsModel,
  type FoundAgent,
  type InstalledAdapter,
  type Participant,
  suggestName,
} from '../../lib/conversations'
import { Button } from '../components/Button'
import { CHROME_ICON_BUTTON_CLASS } from '../components/chromeButtonStyles'
import {
  DropdownMenu,
  DropdownMenuBackItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuTrigger,
} from '../components/DropdownMenu'
import { Input } from '../components/Input'
import { Modal } from './Modal'
import claude from './agent-logos/claude.svg?raw'
import codex from './agent-logos/codex.svg?raw'
import copilot from './agent-logos/copilot.svg?raw'
import cursor from './agent-logos/cursor.svg?raw'
import gemini from './agent-logos/gemini.svg?raw'
import goose from './agent-logos/goose.svg?raw'
import opencode from './agent-logos/opencode.svg?raw'
import qwen from './agent-logos/qwen.svg?raw'
import { Pane } from './ui/Pane'

const PROGRAM_LOGOS: Record<string, string> = {
  'claude-agent-acp': claude,
  'codex-acp': codex,
  copilot,
  'cursor-agent': cursor,
  gemini,
  goose,
  opencode,
  qwen,
}

function AgentIcon({ row }: { row: Row }) {
  const executable = row.definition?.executable ?? row.found?.executable ?? row.setup?.program ?? ''
  const program = executable
    .split(/[\\/]/)
    .pop()!
    .replace(/\.(exe|cmd)$/i, '')
  const logo = PROGRAM_LOGOS[program]
  return logo == null ? (
    <IconTerminal aria-hidden="true" className="size-4 shrink-0" />
  ) : (
    <span
      aria-hidden="true"
      className="size-4 shrink-0 [&>svg]:size-full"
      dangerouslySetInnerHTML={{ __html: logo }}
    />
  )
}

function ModelPicker({
  definition,
  listing,
  onBack,
  onChoose,
}: {
  definition: AgentDefinition
  listing: { error?: string } | null
  onBack: () => void
  onChoose: (model: string) => void
}) {
  const note = 'm-0 px-3 py-1.5 text-xs'
  const list = definition.models
  const current = definition.model ?? ''
  const choices =
    list == null
      ? []
      : [
          {
            id: '',
            name: `Agent default (${list.options.find((m) => m.id === list.default)?.name ?? list.default})`,
          },
          ...list.options,
        ]
  return (
    <>
      <DropdownMenuBackItem onBack={onBack}>
        <IconBox aria-hidden="true" className="size-4" />
        <span className="flex-1 truncate">Model for {definition.name}</span>
      </DropdownMenuBackItem>
      {listing?.error != null && (
        <p role="alert" className={`${note} max-w-72 text-destructive`}>
          {listing.error}
        </p>
      )}
      {list == null ? (
        listing?.error == null && (
          <p role="status" className={`${note} text-muted-foreground`}>
            Starting {definition.name} to list its models…
          </p>
        )
      ) : (
        <Pane className="mt-1 max-h-[320px]">
          {choices.map((m) => (
            <DropdownMenuItem
              key={m.id}
              role="menuitemradio"
              aria-checked={current === m.id}
              selected={current === m.id}
              onSelect={(event) => {
                event.preventDefault()
                onChoose(m.id)
              }}
            >
              <span className="flex-1 truncate">{m.name}</span>
              {current === m.id ? (
                <IconCheck className="ml-auto" />
              ) : (
                <div className="ml-2 h-4 w-4" />
              )}
            </DropdownMenuItem>
          ))}
        </Pane>
      )}
    </>
  )
}

function inside(folder: string, path: string) {
  return path.startsWith(folder) && /[\\/]/.test(path.charAt(folder.length))
}

type Dialog =
  | 'custom'
  | 'auth'
  | 'setup'
  | 'confirm'
  | 'download'
  | 'remove'
  | 'forget'
  | 'rename'
  | null

interface Row {
  key: string
  name: string
  participant?: Participant
  definition?: AgentDefinition
  found?: FoundAgent
  setup?: AgentSetup
}

export function Agents({ model }: { model: ConversationsModel }) {
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
  const [panel, setPanel] = useState<{ row: Row } | null>(null)
  const [renaming, setRenaming] = useState<AgentDefinition | null>(null)
  const [forgetting, setForgetting] = useState<Row | null>(null)
  const [listing, setListing] = useState<{ definition: string; error?: string } | null>(null)
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
    adapters.find((a) => inside(a.folder, row.definition?.executable ?? ''))
  const loadModels = async (definition: AgentDefinition) => {
    setListing({ definition: definition.id })
    try {
      await model.api.agentModels(definition.id)
      await refresh()
    } catch (error) {
      setListing({
        definition: definition.id,
        error:
          error instanceof AgentAuthRequired
            ? `Sign in to ${definition.name} first, then try again.`
            : error instanceof Error
              ? error.message
              : String(error),
      })
    }
  }
  const modelName = (definition: AgentDefinition) => {
    const current = definition.model || definition.models?.default
    if (current == null || current === '') return 'Default'
    return definition.models?.options.find((m) => m.id === current)?.name ?? current
  }
  const sharing =
    removing == null
      ? []
      : definitions.filter(
          (d) =>
            d.id !== removing.row.definition?.id && inside(removing.adapter.folder, d.executable),
        )
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
          setPanel(null)
          if (open) void attempt(refresh)
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-only"
            aria-label="Agents"
            title="Agents"
            className={CHROME_ICON_BUTTON_CLASS}
          >
            <IconSparkle className="size-4 md:size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56 max-w-[calc(100vw-2rem)]">
          {panel != null && panel.row.definition != null ? (
            <ModelPicker
              definition={
                definitions.find((d) => d.id === panel.row.definition!.id) ?? panel.row.definition
              }
              listing={listing?.definition === panel.row.definition.id ? listing : null}
              onBack={() => setPanel(null)}
              onChoose={(value) => {
                const definition = panel.row.definition!
                setPanel(null)
                void attempt(async () => {
                  await model.api.setAgentModel(definition.id, value)
                  await refresh()
                })
              }}
            />
          ) : (
            <>
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
                      <div className="flex items-center gap-1">
                        <DropdownMenuItem
                          aria-label={`Disconnect ${row.name}`}
                          disabled={busy}
                          className="flex-1 gap-2 pl-6"
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
                        {(row.definition != null || adapterOf(row) != null) && (
                          <DropdownMenuSub>
                            <DropdownMenuPrimitive.SubTrigger
                              aria-label={`More actions for ${row.name}`}
                              disabled={busy}
                              className="rounded-md p-1.5 text-muted-foreground outline-none select-none focus:bg-accent data-[state=open]:bg-accent"
                              // Opens on click or keyboard only, not on hover.
                              onPointerMove={(event) => event.preventDefault()}
                              onPointerLeave={(event) => event.preventDefault()}
                            >
                              <IconEllipsis aria-hidden="true" className="size-4" />
                            </DropdownMenuPrimitive.SubTrigger>
                            <DropdownMenuSubContent sideOffset={6}>
                              {row.definition != null && (
                                <DropdownMenuItem
                                  aria-label={`Rename ${row.name}`}
                                  className="gap-2"
                                  onSelect={() => {
                                    setRenaming(row.definition!)
                                    setName(row.definition!.name)
                                    openDialog('rename')
                                  }}
                                >
                                  <IconPencil aria-hidden="true" className="size-4" />
                                  Rename…
                                </DropdownMenuItem>
                              )}
                              {row.definition != null && (
                                <DropdownMenuItem
                                  aria-label={`Forget ${row.name}`}
                                  className="gap-2"
                                  onSelect={() => {
                                    setForgetting(row)
                                    openDialog('forget')
                                  }}
                                >
                                  <IconX aria-hidden="true" className="size-4" />
                                  Forget agent
                                </DropdownMenuItem>
                              )}
                              {adapterOf(row) != null && (
                                <DropdownMenuItem
                                  aria-label={`Remove ${row.name} adapter`}
                                  className="gap-2"
                                  onSelect={() => {
                                    setRemoving({ row, adapter: adapterOf(row)! })
                                    openDialog('remove')
                                  }}
                                >
                                  <IconTrash aria-hidden="true" className="size-4" />
                                  Remove adapter
                                </DropdownMenuItem>
                              )}
                            </DropdownMenuSubContent>
                          </DropdownMenuSub>
                        )}
                      </div>
                      {row.definition != null && (
                        <DropdownMenuItem
                          aria-label={`Model for ${row.name}`}
                          disabled={busy}
                          className="gap-2 pl-6"
                          onSelect={(event) => {
                            event.preventDefault()
                            setPanel({ row })
                            void loadModels(row.definition!)
                          }}
                        >
                          <IconBox aria-hidden="true" className="size-4" />
                          Model
                          <span className={`ml-auto max-w-40 truncate ${hint}`}>
                            {modelName(row.definition)}
                          </span>
                          <IconChevronSm aria-hidden className="text-muted-foreground -rotate-90" />
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
            </>
          )}
          {dialog == null && error != null && (
            <p role="alert" className="max-w-72 p-2 text-xs text-destructive">
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
            {sharing.length > 0 && (
              <p role="alert" className="m-0 text-sm text-destructive">
                {sharing.map((d) => d.name).join(', ')} also {sharing.length === 1 ? 'uses' : 'use'}{' '}
                this adapter and will be forgotten in every repository too.
              </p>
            )}
            <Button
              type="button"
              disabled={busy}
              onClick={() =>
                void attempt(async () => {
                  const forgotten = definitions
                    .filter((d) => inside(removing.adapter.folder, d.executable))
                    .map((d) => d.id)
                  for (const p of model.agents)
                    if (forgotten.includes(p.agent ?? '')) await model.leave(p.id)
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
      {dialog === 'rename' && renaming != null && (
        <Modal title={`Rename ${renaming.name}`} error={error} onClose={() => setDialog(null)}>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              void attempt(async () => {
                await model.renameAgent(renaming.id, name)
                await refresh()
                setDialog(null)
              })
            }}
          >
            <div className="flex flex-col gap-1">
              <label htmlFor={`${id}-rename`}>Name</label>
              <Input
                id={`${id}-rename`}
                data-autofocus
                maxLength={128}
                value={name}
                aria-describedby={`${id}-rename-hint`}
                onChange={(event) => setName(event.target.value)}
              />
              <p id={`${id}-rename-hint`} className={`m-0 ${hint}`}>
                Used to @mention it in every repository. Leave empty for its default name.
              </p>
            </div>
            <Button type="submit" disabled={busy}>
              Rename
            </Button>
          </form>
        </Modal>
      )}
      {dialog === 'forget' && forgetting != null && (
        <Modal title={`Forget ${forgetting.name}`} error={error} onClose={() => setDialog(null)}>
          <div className="flex flex-col gap-3">
            <p className="m-0 text-sm">
              Gitna removes its saved command and model and disconnects it in every repository. Its
              conversations stay.
            </p>
            <Button
              type="button"
              disabled={busy}
              onClick={() => void forget(forgetting).then((done) => done && setDialog(null))}
            >
              Forget agent
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
                  data-autofocus
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
