import type { ScheduleSpec } from './types.js'

type LocalMinute = { year: number; month: number; day: number; hour: number; minute: number; weekday: number }

const formatters = new Map<string, Intl.DateTimeFormat>()

export function validateSchedule(schedule: ScheduleSpec): void {
  if (schedule.kind === 'once') {
    if (!Number.isFinite(Date.parse(schedule.at))) throw new Error('once.at must be an ISO timestamp')
    return
  }
  timezoneFormatter(schedule.timezone)
  if (!Number.isInteger(schedule.hour) || schedule.hour < 0 || schedule.hour > 23) throw new Error('schedule hour must be between 0 and 23')
  if (!Number.isInteger(schedule.minute) || schedule.minute < 0 || schedule.minute > 59) throw new Error('schedule minute must be between 0 and 59')
  if (schedule.kind === 'weekly') {
    if (schedule.daysOfWeek.length < 1 || schedule.daysOfWeek.length > 7) throw new Error('weekly daysOfWeek must contain 1 to 7 days')
    if (new Set(schedule.daysOfWeek).size !== schedule.daysOfWeek.length || schedule.daysOfWeek.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
      throw new Error('weekly daysOfWeek must contain unique integers from 0 (Sunday) to 6')
    }
  }
}

/** Returns the first matching real instant strictly after `after` (DST gaps are skipped). */
export function nextOccurrence(schedule: ScheduleSpec, after: Date): Date | null {
  validateSchedule(schedule)
  if (schedule.kind === 'once') {
    const at = new Date(schedule.at)
    return at.getTime() > after.getTime() ? at : null
  }
  const start = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000
  const maxMinutes = schedule.kind === 'daily' ? 3 * 24 * 60 : 9 * 24 * 60
  const previous = localMinute(after, schedule.timezone)
  for (let offset = 0; offset < maxMinutes; offset += 1) {
    const candidate = new Date(start + offset * 60_000)
    const local = localMinute(candidate, schedule.timezone)
    if (local.hour !== schedule.hour || local.minute !== schedule.minute) continue
    if (schedule.kind === 'weekly' && !schedule.daysOfWeek.includes(local.weekday)) continue
    // A fall-back transition exposes the same wall-clock minute twice. It is one occurrence.
    if (sameLocalMinute(local, previous)) continue
    return candidate
  }
  throw new Error('could not resolve the next schedule occurrence')
}

function timezoneFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone)
  if (formatter) return formatter
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
    })
  } catch {
    throw new Error('schedule timezone must be a valid IANA timezone')
  }
  // Force ICU to reject invalid zones now rather than during a future tick.
  formatter.format(new Date(0))
  formatters.set(timezone, formatter)
  return formatter
}

function localMinute(date: Date, timezone: string): LocalMinute {
  const parts = Object.fromEntries(timezoneFormatter(timezone).formatToParts(date).map((part) => [part.type, part.value]))
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), weekday: weekdays[parts.weekday!]!,
  }
}

function sameLocalMinute(a: LocalMinute, b: LocalMinute): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute
}
