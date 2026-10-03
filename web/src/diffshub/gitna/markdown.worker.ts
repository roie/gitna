import {
  parseMarkdown,
  type MarkdownParseRequest,
  type MarkdownParseResponse,
} from './markdownParser'

self.onmessage = ({ data }: MessageEvent<MarkdownParseRequest>) => {
  let response: MarkdownParseResponse
  try {
    response = { id: data.id, tree: parseMarkdown(data.value) }
  } catch (error) {
    response = { id: data.id, error: error instanceof Error ? error.message : String(error) }
  }
  self.postMessage(response)
}
