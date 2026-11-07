import type { FastifyInstance } from 'fastify';

/** RFC 9457 problem details. `detail` is a fixed, generic sentence, never derived from input. */
export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly instance?: string;
}

const TYPE_BASE = 'https://errors.glucorp.health/';

/** An error that maps to a known problem response. `code` is safe to log and audit. */
export class ProblemError extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;

  constructor(status: number, code: string, title: string) {
    super(code);
    this.name = 'ProblemError';
    this.status = status;
    this.code = code;
    this.title = title;
  }
}

export function problemBody(
  status: number,
  code: string,
  title: string,
  requestId: string,
): ProblemDetails {
  return { type: `${TYPE_BASE}${code}`, title, status, instance: `urn:request:${requestId}` };
}

interface FastifyLikeError {
  readonly statusCode?: number;
  readonly validation?: unknown;
  readonly code?: string;
  readonly name?: string;
}

/**
 * Error and 404 handlers that never echo submitted data, stack traces or messages (spec 9.1).
 * Logs carry only the error name and code.
 */
export function registerProblemHandlers(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyLikeError, request, reply) => {
    let status = 500;
    let code = 'internal';
    let title = 'Something went wrong on our side. Try again later.';

    if (error instanceof ProblemError) {
      ({ status, code, title } = error);
    } else if (error.validation !== undefined || error.code === 'FST_ERR_CTP_INVALID_JSON_BODY') {
      status = 400;
      code = 'validation';
      title = 'The request was not valid.';
    } else if (error.statusCode === 413) {
      status = 413;
      code = 'too_large';
      title = 'The request was too large.';
    } else if (
      error.statusCode !== undefined &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    ) {
      status = error.statusCode;
      code = 'bad_request';
      title = 'The request could not be processed.';
    }

    if (status >= 500) {
      request.log.error({
        event: 'request.error',
        errorName: error.name,
        errorCode: error.code ?? code,
      });
    }
    void reply
      .code(status)
      .type('application/problem+json')
      .send(problemBody(status, code, title, request.id));
  });

  app.setNotFoundHandler((request, reply) => {
    void reply
      .code(404)
      .type('application/problem+json')
      .send(problemBody(404, 'not_found', 'Not found.', request.id));
  });
}
