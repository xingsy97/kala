export function auditLog(event, fields = {}) {
  return JSON.stringify({ event, fields })
}
