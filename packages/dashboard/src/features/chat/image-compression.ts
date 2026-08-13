import {
  IMAGE_COMPRESSION_MAX_EDGE,
  IMAGE_COMPRESSION_QUALITY,
  MAX_IMAGE_DECODED_BYTES,
  detectBase64ImageMediaType,
} from '@agent-kernel/shared'

export type PreparedImage = {
  dataUrl: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  base64: string
  decodedBytes: number
}

const MIN_EDGE = 640
const QUALITY_STEPS = [IMAGE_COMPRESSION_QUALITY, 0.72, 0.62]
const DECODE_TIMEOUT_MS = 5_000
const COMPRESS_ABOVE_BYTES = 512 * 1024

export async function prepareComposerImage(file: File): Promise<PreparedImage> {
  const original = await readFileAsDataUrl(file)
  const originalMediaType = supportedMediaType(file.type)
  if (originalMediaType === 'image/gif' || typeof document === 'undefined' || file.size <= COMPRESS_ABOVE_BYTES) {
    return fromDataUrl(original, originalMediaType, file.size)
  }

  try {
    const image = await loadImage(original)
    let maxEdge = IMAGE_COMPRESSION_MAX_EDGE
    while (maxEdge >= MIN_EDGE) {
      const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight))
      const width = Math.max(1, Math.round(image.naturalWidth * scale))
      const height = Math.max(1, Math.round(image.naturalHeight * scale))
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d', { alpha: true })
      if (!context) break
      context.drawImage(image, 0, 0, width, height)
      for (const quality of QUALITY_STEPS) {
        const blob = await canvasToBlob(canvas, 'image/webp', quality)
        if (!blob) continue
        const dataUrl = await readFileAsDataUrl(blob)
        const requestedType = supportedMediaType(blob.type)
        const prepared = fromDataUrl(dataUrl, requestedType, blob.size)
        const verified = normalizePreparedImageMediaType(prepared)
        if (!verified) continue
        if (verified.decodedBytes <= MAX_IMAGE_DECODED_BYTES) return verified
      }
      maxEdge = Math.floor(maxEdge * 0.75)
    }
  } catch {
    // Preserve the original so the deterministic size/type validation can show
    // an actionable error instead of making paste silently fail.
  }
  return fromDataUrl(original, originalMediaType, file.size)
}

export function normalizePreparedImageMediaType(prepared: PreparedImage): PreparedImage | null {
  const detectedType = detectBase64ImageMediaType(prepared.base64)
  if (!detectedType) return null
  if (detectedType === prepared.mediaType) return prepared
  return {
    ...prepared,
    mediaType: detectedType,
    dataUrl: `data:${detectedType};base64,${prepared.base64}`,
  }
}

export function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('failed to read image'))
    reader.readAsDataURL(file)
  })
}

function supportedMediaType(value: string): PreparedImage['mediaType'] {
  if (value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif') return value
  return 'image/png'
}

function fromDataUrl(dataUrl: string, mediaType: PreparedImage['mediaType'], fallbackBytes: number): PreparedImage {
  const comma = dataUrl.indexOf(',')
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : ''
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  const decodedBytes = base64.length % 4 === 0 ? (base64.length / 4) * 3 - padding : fallbackBytes
  return { dataUrl, mediaType, base64, decodedBytes }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    const timer = window.setTimeout(() => reject(new Error('image decode timed out')), DECODE_TIMEOUT_MS)
    image.onload = () => { window.clearTimeout(timer); resolve(image) }
    image.onerror = () => { window.clearTimeout(timer); reject(new Error('image decode failed')) }
    image.src = src
  })
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
}
