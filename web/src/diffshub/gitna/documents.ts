export type DocumentSaveState = 'clean' | 'dirty' | 'saving' | 'error'

export interface DocumentSnapshot {
  readonly id: string
  readonly folderKey?: string
  readonly path?: string
  readonly label: string
  readonly contents: string
  readonly revision: number
  readonly savedRevision: number
  readonly baselineHash?: string
  readonly dirty: boolean
  readonly saveState: DocumentSaveState
}

type DocumentRecord = {
  id: string
  folderKey?: string
  path?: string
  label: string
  contents: string
  revision: number
  savedRevision: number
  savedContents: string
  baselineHash?: string
  saveState: DocumentSaveState
}

function documentId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `document-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function snapshot(document: DocumentRecord): DocumentSnapshot {
  return {
    id: document.id,
    folderKey: document.folderKey,
    path: document.path,
    label: document.label,
    contents: document.contents,
    revision: document.revision,
    savedRevision: document.savedRevision,
    baselineHash: document.baselineHash,
    dirty: document.contents !== document.savedContents,
    saveState: document.saveState,
  }
}

export class DocumentStore {
  private readonly documents = new Map<string, DocumentRecord>()
  private nextUntitled = 1

  createUntitled(contents = '', folderKey?: string): DocumentSnapshot {
    const id = documentId()
    const label = this.nextUntitledLabel()
    const document: DocumentRecord = {
      id,
      folderKey,
      label,
      contents,
      revision: 0,
      savedRevision: 0,
      savedContents: contents,
      saveState: contents === '' ? 'clean' : 'dirty',
    }
    this.documents.set(id, document)
    return snapshot(document)
  }

  createBound(
    path: string,
    contents: string,
    options: { folderKey?: string; baselineHash?: string; label?: string } = {},
  ): DocumentSnapshot {
    const document: DocumentRecord = {
      id: documentId(),
      folderKey: options.folderKey,
      path,
      label: options.label ?? path.split('/').at(-1) ?? path,
      contents,
      revision: 0,
      savedRevision: 0,
      savedContents: contents,
      baselineHash: options.baselineHash,
      saveState: 'clean',
    }
    this.documents.set(document.id, document)
    return snapshot(document)
  }

  get(id: string): DocumentSnapshot | null {
    const document = this.documents.get(id)
    return document == null ? null : snapshot(document)
  }

  list(): readonly DocumentSnapshot[] {
    return [...this.documents.values()].map(snapshot)
  }

  findByPath(path: string): DocumentSnapshot | null {
    for (const document of this.documents.values()) {
      if (document.path === path) return snapshot(document)
    }
    return null
  }

  updateContent(id: string, contents: string): DocumentSnapshot {
    const document = this.require(id)
    if (document.contents !== contents) {
      document.contents = contents
      document.revision += 1
    }
    document.saveState = document.contents === document.savedContents ? 'clean' : 'dirty'
    return snapshot(document)
  }

  beginSave(id: string): DocumentSnapshot {
    const document = this.require(id)
    document.saveState = 'saving'
    return snapshot(document)
  }

  acknowledgeSave(
    id: string,
    revision: number,
    contents: string,
    options: { path?: string; baselineHash?: string; label?: string } = {},
  ): DocumentSnapshot {
    const document = this.require(id)
    if (revision > document.revision) {
      throw new Error(`Cannot acknowledge future revision ${revision}`)
    }
    document.savedContents = contents
    document.savedRevision = revision
    if (options.path !== undefined) {
      document.path = options.path
      document.label = options.label ?? options.path.split('/').at(-1) ?? options.path
    } else if (options.label !== undefined) {
      document.label = options.label
    }
    if (options.baselineHash !== undefined) document.baselineHash = options.baselineHash
    document.saveState = document.contents === document.savedContents ? 'clean' : 'dirty'
    return snapshot(document)
  }

  setSaveError(id: string): DocumentSnapshot {
    const document = this.require(id)
    document.saveState = 'error'
    return snapshot(document)
  }

  bindPath(id: string, path: string, label = path.split('/').at(-1) ?? path): DocumentSnapshot {
    const document = this.require(id)
    document.path = path
    document.label = label
    return snapshot(document)
  }

  delete(id: string): void {
    this.documents.delete(id)
  }

  private nextUntitledLabel(): string {
    const label = `Untitled-${this.nextUntitled}`
    this.nextUntitled += 1
    return label
  }

  private require(id: string): DocumentRecord {
    const document = this.documents.get(id)
    if (document == null) throw new Error(`Unknown document: ${id}`)
    return document
  }
}
