import { createHash } from 'node:crypto'

export function dedicatedSettingsFingerprint(settings, modelCatalog) {
  const models = Array.isArray(modelCatalog?.models) ? modelCatalog.models : []
  const defaultModel = canonicalDefaultModel(settings?.defaultModel, models)
  const providers = Array.isArray(settings?.providers)
    ? settings.providers.map((provider) => ({
      id: provider?.id,
      models: Array.isArray(provider?.models) ? provider.models.map((model) => model?.ref).filter((ref) => typeof ref === 'string').sort() : [],
    })).sort((a, b) => String(a.id).localeCompare(String(b.id)))
    : []
  return createHash('sha256').update(JSON.stringify({ defaultModel, providers })).digest('hex')
}

function canonicalDefaultModel(value, models) {
  if (typeof value !== 'string' || !value) return null
  const exact = models.find((model) => model?.ref === value)
  if (typeof exact?.ref === 'string') return exact.ref
  const matches = models.filter((model) => model?.id === value && typeof model?.ref === 'string')
  return matches.length === 1 ? matches[0].ref : value
}
