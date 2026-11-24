import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
} from 'react'
import { createApi } from '../lib/api'
import { GitnaRepository } from './repository'

const RepositoryContext = createContext<GitnaRepository | null>(null)

export function RepositoryProvider({
  children,
  baseURL,
}: {
  children: ReactNode
  baseURL?: string
}) {
  const storeRef = useRef<GitnaRepository | null>(null)
  storeRef.current ??= new GitnaRepository(
    createApi(baseURL),
    baseURL == null ? undefined : new URL('api/v1/events', baseURL).href,
  )
  const repository = storeRef.current

  useEffect(() => {
    void repository.refreshCurrentFolder()
    return repository.connectEvents()
  }, [repository])

  return <RepositoryContext.Provider value={repository}>{children}</RepositoryContext.Provider>
}

export function useRepository(): GitnaRepository {
  const repository = useContext(RepositoryContext)
  if (repository == null) throw new Error('Missing Gitna repository provider')
  useSyncExternalStore(repository.subscribe, repository.getVersion, repository.getVersion)
  return repository
}
