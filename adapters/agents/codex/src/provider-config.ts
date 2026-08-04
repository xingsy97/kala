const PROVIDER_ID = 'agent_eval'

export function codexProviderConfigArgs(baseUrl: string): string[] {
  return [
    '-c', 'model_provider=' + JSON.stringify(PROVIDER_ID),
    '-c', 'model_providers.' + PROVIDER_ID + '.name=' + JSON.stringify('Agent Evaluation'),
    '-c', 'model_providers.' + PROVIDER_ID + '.base_url=' + JSON.stringify(baseUrl),
    '-c', 'model_providers.' + PROVIDER_ID + '.wire_api=' + JSON.stringify('responses'),
    '-c', 'model_providers.' + PROVIDER_ID + '.env_key=' + JSON.stringify('OPENAI_API_KEY'),
  ]
}
