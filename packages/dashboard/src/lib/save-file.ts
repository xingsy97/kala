export type SaveFileInput = {
  suggestedName: string
  blob: Blob
  mimeType?: string
}

export type SaveFileResult = 'saved' | 'downloaded' | 'cancelled'

type SavePickerWindow = Window & typeof globalThis & {
  showSaveFilePicker?: (options: { suggestedName: string; types?: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<FileSystemFileHandle>
}

export async function saveFile(input: SaveFileInput, windowValue: SavePickerWindow = window as SavePickerWindow): Promise<SaveFileResult> {
  const picker = windowValue.showSaveFilePicker
  if (typeof picker === 'function') {
    try {
      const handle = await picker({
        suggestedName: input.suggestedName,
        types: filePickerTypes(input.suggestedName, input.mimeType ?? input.blob.type),
      })
      const writable = await handle.createWritable()
      await writable.write(input.blob)
      await writable.close()
      return 'saved'
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled'
    }
  }
  downloadBlob(input.blob, input.suggestedName, windowValue)
  return 'downloaded'
}

export function downloadBlob(blob: Blob, filename: string, windowValue: Window = window): void {
  const url = URL.createObjectURL(blob)
  const anchor = windowValue.document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  windowValue.document.body.append(anchor)
  anchor.click()
  windowValue.setTimeout(() => {
    anchor.remove()
    URL.revokeObjectURL(url)
  }, 60_000)
}

function filePickerTypes(filename: string, mimeType: string): Array<{ description: string; accept: Record<string, string[]> }> | undefined {
  const normalizedMimeType = mimeType.split(';', 1)[0]?.trim() ?? ''
  if (!normalizedMimeType) return undefined
  const dot = filename.lastIndexOf('.')
  const extension = dot > 0 ? filename.slice(dot) : ''
  return [{ description: normalizedMimeType, accept: { [normalizedMimeType]: extension ? [extension] : [] } }]
}
