import { fileGutterChanges } from './changeGutter'

self.onmessage = (event: MessageEvent<{ before: string; after: string }>) => {
  try {
    self.postMessage(fileGutterChanges(event.data.before, event.data.after))
  } catch {
    self.postMessage(null)
  }
}
