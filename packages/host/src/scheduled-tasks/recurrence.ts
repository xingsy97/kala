import type { ScheduleSpec } from './types.js'

type LocalMinute = { year: number; month: number; day: number; hour: number; minute: number; weekday: number }
type CalendarDate = Pick<LocalMinute, 'year' | 'month' | 'day'>

const formatters = new Map<string, Intl.DateTimeFormat>()
const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS

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
  if (schedule.kind === 'interval') {
    if (!Number.isInteger(schedule.everyDays) || schedule.everyDays < 1 || schedule.everyDays > 3650) throw new Error('interval everyDays must be an integer between 1 and 3650')
    parseCalendarDate(schedule.startDate, 'interval startDate')
  }
  if (schedule.kind === 'monthly') {
    if (schedule.daysOfMonth.length < 1 || schedule.daysOfMonth.length > 31) throw new Error('monthly daysOfMonth must contain 1 to 31 days')
    if (new Set(schedule.daysOfMonth).size !== schedule.daysOfMonth.length || schedule.daysOfMonth.some((day) => !Number.isInteger(day) || day < 1 || day > 31)) {
      throw new Error('monthly daysOfMonth must contain unique integers from 1 to 31')
    }
  }
}

/** Returns the first matching real instant strictly after `after` (DST gaps and nonexistent monthly dates are skipped). */
export function nextOccurrence(schedule: ScheduleSpec, after: Date): Date | null {
  validateSchedule(schedule)
  if (schedule.kind === 'once') {
    const at = new Date(schedule.at)
    return at.getTime() > after.getTime() ? at : null
  }

  const localAfter = localMinute(after, schedule.timezone)
  const afterDay = epochDay(localAfter)
  if (schedule.kind === 'daily') {
    return firstResolved(schedule, after, [afterDay, afterDay + 1, afterDay + 2])
  }
  if (schedule.kind === 'weekly') {
    const days = Array.from({ length: 15 }, (_, offset) => afterDay + offset)
      .filter((day) => schedule.daysOfWeek.includes(calendarDate(day).weekday))
    return firstResolved(schedule, after, days)
  }
  if (schedule.kind === 'interval') {
    const anchorDay = epochDay(parseCalendarDate(schedule.startDate, 'interval startDate'))
    const delta = Math.max(0, afterDay - anchorDay)
    const firstDay = anchorDay + Math.ceil(delta / schedule.everyDays) * schedule.everyDays
    return firstResolved(schedule, after, Array.from({ length: 4 }, (_, offset) => firstDay + offset * schedule.everyDays))
  }

  const days: number[] = []
  for (let monthOffset = 0; monthOffset < 24; monthOffset += 1) {
    const month = addMonths(localAfter.year, localAfter.month, monthOffset)
    for (const day of [...schedule.daysOfMonth].sort((a, b) => a - b)) {
      if (day > daysInMonth(month.year, month.month)) continue
      const candidate = epochDay({ ...month, day })
      if (candidate >= afterDay) days.push(candidate)
    }
  }
  return firstResolved(schedule, after, days)
}

function firstResolved(schedule: Exclude<ScheduleSpec, { kind: 'once' }>, after: Date, days: number[]): Date {
  for (const day of days) {
    const candidate = resolveLocalMinute(calendarDate(day), schedule.hour, schedule.minute, schedule.timezone)
    if (candidate && candidate.getTime() > after.getTime()) return candidate
  }
  throw new Error('could not resolve the next schedule occurrence')
}

/** Resolve a wall-clock minute to its earliest real instant; a DST gap has no result. */
function resolveLocalMinute(date: CalendarDate, hour: number, minute: number, timezone: string): Date | undefined {
  const target = utcMillis(date, hour, minute)
  const offsets = new Set<number>()
  for (const sampleDays of [-7, -2, -1, 0, 1, 2, 7]) {
    const sample = new Date(target + sampleDays * DAY_MS)
    const local = localMinute(sample, timezone)
    offsets.add((utcMillis(local, local.hour, local.minute) - sample.getTime()) / MINUTE_MS)
  }
  const candidates = [...offsets]
    .map((offset) => new Date(target - offset * MINUTE_MS))
    .filter((candidate) => sameWallMinute(localMinute(candidate, timezone), { ...date, hour, minute }))
    .sort((a, b) => a.getTime() - b.getTime())
  return candidates[0]
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

function parseCalendarDate(value: string, name: string): CalendarDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
  if (!match) throw new Error(`${name} must be a valid YYYY-MM-DD date`)
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
  if (date.year < 1 || date.month < 1 || date.month > 12 || date.day < 1 || date.day > daysInMonth(date.year, date.month)) {
    throw new Error(`${name} must be a valid YYYY-MM-DD date`)
  }
  return date
}

function epochDay(date: CalendarDate): number { return Math.floor(utcMillis(date, 0, 0) / DAY_MS) }

function calendarDate(day: number): CalendarDate & { weekday: number } {
  const date = new Date(day * DAY_MS)
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), weekday: date.getUTCDay() }
}

function utcMillis(date: CalendarDate, hour: number, minute: number): number {
  const result = new Date(0)
  result.setUTCFullYear(date.year, date.month - 1, date.day)
  result.setUTCHours(hour, minute, 0, 0)
  return result.getTime()
}

function addMonths(year: number, month: number, offset: number): Pick<CalendarDate, 'year' | 'month'> {
  const index = year * 12 + month - 1 + offset
  return { year: Math.floor(index / 12), month: index % 12 + 1 }
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

function isLeapYear(year: number): boolean { return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) }

function sameWallMinute(actual: LocalMinute, expected: CalendarDate & { hour: number; minute: number }): boolean {
  return actual.year === expected.year && actual.month === expected.month && actual.day === expected.day
    && actual.hour === expected.hour && actual.minute === expected.minute
}
