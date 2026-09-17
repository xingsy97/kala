export type OctopusVariant = 'web' | 'desktop'

const arms = 'M22 34C14 34 13 41 10 38M24 38C18 44 16 49 13 44M28 40C26 47 22 52 20 46M31 40C31 50 27 53 26 47M42 34C50 34 51 41 54 38M40 38C46 44 48 49 51 44M36 40C38 47 42 52 44 46M33 40C33 50 37 53 38 47'
const head = 'M18 33C18 21 23 14 32 14S46 21 46 33V35C46 40 40 43 32 43S18 40 18 35Z'

function character(color: string, face: string): string {
  return `<path d="${arms}" fill="none" stroke="${color}" stroke-width="4.5" stroke-linecap="round"/><path d="${head}" fill="${color}"/><g fill="${face}"><circle cx="26" cy="30" r="2.4"/><circle cx="38" cy="30" r="2.4"/></g><path d="M29 35Q32 38 35 35" fill="none" stroke="${face}" stroke-width="2" stroke-linecap="round"/>`
}

export function octopusSvg(variant: OctopusVariant, options: { maskable?: boolean; runningFrame?: number } = {}): string {
  const color = variant === 'desktop' ? '#8be0d5' : '#ffa58f'
  const dock = variant === 'desktop' ? `<rect x="25" y="54" width="14" height="2.5" rx="1.25" fill="${color}"/>` : ''
  const progress = options.runningFrame === undefined ? '' : `<g transform="rotate(${(options.runningFrame % 4) * 90} 54 10)"><circle cx="54" cy="10" r="7" fill="#172538"/><path d="M54 5a5 5 0 0 1 5 5" fill="none" stroke="#a7f3d0" stroke-width="3" stroke-linecap="round"/></g>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="${options.maskable ? 0 : 14}" fill="#172538"/><g${options.maskable ? ' transform="translate(32 32) scale(.88) translate(-32 -32)"' : ''}>${character(color, '#172538')}${dock}</g>${progress}</svg>`
}

export function octopusBadgeSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><mask id="octopus">${character('#fff', '#000')}</mask></defs><rect width="64" height="64" fill="#fff" mask="url(#octopus)"/></svg>`
}
