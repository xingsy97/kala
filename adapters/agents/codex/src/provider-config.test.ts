import { describe, expect, it } from 'vitest'

import { codexProviderConfigArgs } from './provider-config.js'

describe('codexProviderConfigArgs', () => {
  it('declares an isolated Responses provider bound to the resolved credential environment', () => {
    expect(codexProviderConfigArgs('http://127.0.0.1:18080/v1')).toEqual([
      '-c', 'model_provider=\"agent_eval\"',
      '-c', 'model_providers.agent_eval.name=\"Agent Evaluation\"',
      '-c', 'model_providers.agent_eval.base_url=\"http://127.0.0.1:18080/v1\"',
      '-c', 'model_providers.agent_eval.wire_api=\"responses\"',
      '-c', 'model_providers.agent_eval.env_key=\"OPENAI_API_KEY\"',
    ])
  })
})
