import { describe, expect, it } from 'vitest'

import { normalizePreparedImageMediaType } from './image-compression.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64')
const WEBP = Buffer.from('RIFFxxxxWEBP', 'ascii').toString('base64')

describe('composer image compression media type', () => {
  it('corrects a browser WebP fallback to the actual PNG media type', () => {
    const normalized = normalizePreparedImageMediaType({ dataUrl: `data:image/webp;base64,${PNG}`, mediaType: 'image/webp', base64: PNG, decodedBytes: 8 })
    expect(normalized?.mediaType).toBe('image/png')
    expect(normalized?.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('corrects a mislabeled fallback to JPEG and preserves real WebP', () => {
    expect(normalizePreparedImageMediaType({ dataUrl: `data:image/webp;base64,${JPEG}`, mediaType: 'image/webp', base64: JPEG, decodedBytes: 4 })?.mediaType).toBe('image/jpeg')
    expect(normalizePreparedImageMediaType({ dataUrl: `data:image/webp;base64,${WEBP}`, mediaType: 'image/webp', base64: WEBP, decodedBytes: 12 })?.mediaType).toBe('image/webp')
  })

  it('rejects an unrecognized encoder result instead of mislabeling it', () => {
    const invalid = Buffer.from('ordinary bytes').toString('base64')
    expect(normalizePreparedImageMediaType({ dataUrl: `data:image/webp;base64,${invalid}`, mediaType: 'image/webp', base64: invalid, decodedBytes: 14 })).toBeNull()
  })
})
