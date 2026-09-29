import 'node:zlib'

declare module 'node:zlib' {
  export function zstdCompressSync(buffer: InputType, options?: ZlibOptions): Buffer
  export function zstdDecompressSync(buffer: InputType, options?: ZlibOptions): Buffer
}
