import { formatGreeting } from './formatter.mjs'

export function createGreeting(config, name) {
  return formatGreeting(config.greetingPrefix, name, config.punctuation)
}
