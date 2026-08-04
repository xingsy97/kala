export type SafeHttpErrorCode = 'INVALID_REQUEST' | 'NOT_FOUND' | 'CONFLICT' | 'INTERNAL_ERROR'

export class SafeHttpError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 500, readonly code: SafeHttpErrorCode, readonly safeMessage: string, options?: ErrorOptions) {
    super(safeMessage, options)
    this.name = 'SafeHttpError'
  }
}

export class InvalidRequestError extends SafeHttpError {
  constructor(message = 'request is invalid', options?: ErrorOptions) { super(400, 'INVALID_REQUEST', message, options) }
}

export class NotFoundError extends SafeHttpError {
  constructor(message = 'requested resource was not found', options?: ErrorOptions) { super(404, 'NOT_FOUND', message, options) }
}

export class ConflictError extends SafeHttpError {
  constructor(message = 'request conflicts with current state', options?: ErrorOptions) { super(409, 'CONFLICT', message, options) }
}
