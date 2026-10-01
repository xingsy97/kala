const PROTOTYPE_ASSET_VERSION = 'production-ui-v1'

export function staticAssetUrl(path: string): string {
  return import.meta.env.VITE_KALA_PROTOTYPE === '1'
    ? `${path}?prototype=${PROTOTYPE_ASSET_VERSION}`
    : path
}
