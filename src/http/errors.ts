/**
 * A request refused because of what the client sent, not because the server
 * failed. Its `status`, `code` and `message` are written for the client, and the
 * API error boundary sends them as they are.
 */
export class ClientRequestError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413 | 415,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ClientRequestError';
  }
}

/** An id, from a path or a body, that could never name a stored record. */
export class InvalidIdentifierError extends ClientRequestError {
  constructor() {
    super(400, 'invalid_id', 'Invalid identifier.');
    this.name = 'InvalidIdentifierError';
  }
}
