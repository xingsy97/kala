import { describe, expect, it } from 'vitest'
import type { ImageContent } from '@agent-kernel/kernel'

import {
  CLIENT_MESSAGE_SAFE_BYTES,
  MAX_IMAGE_DECODED_BYTES,
  MAX_MESSAGE_IMAGE_BYTES,
  decodedBase64Bytes,
  detectBase64ImageMediaType,
  validateClientMessagePayload,
  validateInlineMessageImages,
} from './image-message-policy.js'

function image(bytes: number): ImageContent {
  const content = Buffer.alloc(Math.max(bytes, 8))
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(content)
  return {
    type: 'image',
    source: { kind: 'base64', mediaType: 'image/png', data: content.subarray(0, bytes).toString('base64') },
  }
}

describe('image message policy', () => {
  it('calculates padded base64 sizes and rejects malformed input', () => {
    expect(decodedBase64Bytes(Buffer.from('hello').toString('base64'))).toBe(5)
    expect(decodedBase64Bytes('not base64!')).toBeNull()
    expect(validateInlineMessageImages([{ type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: Buffer.from('not a png').toString('base64') } }])).toMatchObject({ ok: false, error: { code: 'IMAGE_INVALID_BASE64' } })
  })

  it('detects image media types from file signatures', () => {
    const png = image(8).source
    expect(detectBase64ImageMediaType(png.kind === 'base64' ? png.data : '')).toBe('image/png')
    expect(detectBase64ImageMediaType(Buffer.from([0xff, 0xd8, 0xff]).toString('base64'))).toBe('image/jpeg')
    expect(detectBase64ImageMediaType(Buffer.from('GIF89a', 'ascii').toString('base64'))).toBe('image/gif')
    expect(detectBase64ImageMediaType(Buffer.from('RIFFxxxxWEBP', 'ascii').toString('base64'))).toBe('image/webp')
  })

  it('accepts two bounded images', () => {
    expect(validateInlineMessageImages([image(300_000), image(400_000)])).toEqual({
      ok: true,
      imageCount: 2,
      decodedImageBytes: 700_000,
    })
  })

  it('rejects too many images, an oversized image, and an oversized total', () => {
    expect(validateInlineMessageImages([image(1), image(1), image(1), image(1), image(1)])).toMatchObject({ ok: false, error: { code: 'IMAGE_COUNT_EXCEEDED' } })
    expect(validateInlineMessageImages([image(MAX_IMAGE_DECODED_BYTES + 1)])).toMatchObject({ ok: false, error: { code: 'IMAGE_TOO_LARGE' } })
    expect(validateInlineMessageImages([image(MAX_MESSAGE_IMAGE_BYTES / 2), image(MAX_MESSAGE_IMAGE_BYTES / 2), image(8)])).toMatchObject({ ok: false, error: { code: 'MESSAGE_IMAGES_TOO_LARGE' } })
  })

  it('rejects an encoded socket payload above the safe client threshold', () => {
    expect(validateClientMessagePayload({ text: 'x'.repeat(CLIENT_MESSAGE_SAFE_BYTES + 1) })).toMatchObject({ code: 'MESSAGE_PAYLOAD_TOO_LARGE' })
    expect(validateClientMessagePayload({ text: 'small' })).toBeNull()
  })
})
