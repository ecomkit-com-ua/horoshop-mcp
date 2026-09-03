/**
 * Horoshop API client.
 *
 * The whole API is JSON POST to https://<DOMAIN>/api/<function>/ with a `token` in the *body*
 * (there is no header auth). Every response is wrapped in {"status": ..., "response": ...},
 * except the hooks/* functions, which answer with a bare object and a meaningful HTTP status.
 *
 * Docs: https://horoshop.notion.site/api-doc
 */

import type { Config } from './config.js';

/** Token lifetime is 600s; refresh early so a call never races the expiry. */
const TOKEN_TTL_MS = 600_000;
const TOKEN_SLACK_MS = 30_000;

export type ApiStatus =
  | 'OK'
  | 'WARNING'
  | 'EMPTY'
  | 'ERROR'
  | 'EXCEPTION'
  | 'UNAUTHORIZED'
  | 'AUTHORIZATION_ERROR'
  | 'UNDEFINED_FUNCTION'
  | 'HTTP_ERROR';

export interface ApiEnvelope {
  status?: ApiStatus | string;
  response?: unknown;
  [key: string]: unknown;
}

/** A call that reached Horoshop and came back parseable — success or API-level error. */
export interface ApiResult {
  ok: boolean;
  status: string;
  /** Unwrapped `response` for enveloped calls, whole body for hooks/*. */
  data: unknown;
  message?: string;
  httpStatus: number;
}

export class HoroshopError extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'HoroshopError';
  }
}

/** Statuses that mean "the call worked", even if some records inside it did not. */
const SUCCESS_STATUSES = new Set(['OK', 'WARNING', 'EMPTY']);
const AUTH_FAILURE_STATUSES = new Set(['UNAUTHORIZED', 'AUTHORIZATION_ERROR']);

export class HoroshopClient {
  private token: string | null = null;
  private tokenExpiresAt = 0;
  /** In-flight auth, so concurrent tool calls share one login round trip. */
  private pendingAuth: Promise<string> | null = null;

  constructor(private readonly config: Config) {}

  get baseUrl(): string {
    return `${this.config.protocol}://${this.config.domain}/api`;
  }

  private endpoint(fn: string): string {
    // Horoshop routes /api/<function>/ with a trailing slash. Tolerate callers who pass
    // "/catalog/export", "catalog/export/" or a bare "catalog/export".
    const clean = fn.trim().replace(/^\/+/, '').replace(/\/+$/, '');
    return `${this.baseUrl}/${clean}/`;
  }

  private async post(url: string, body: unknown): Promise<{ httpStatus: number; parsed: unknown; raw: string }> {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new HoroshopError(
        isTimeout
          ? `Horoshop did not answer within ${this.config.timeoutMs}ms (${url}).`
          : `Could not reach Horoshop at ${url}: ${reason}`,
      );
    }

    const raw = await res.text();
    let parsed: unknown;
    try {
      parsed = raw.length ? JSON.parse(raw) : null;
    } catch {
      // A store that is down, behind Cloudflare or missing the API module answers with HTML.
      throw new HoroshopError(
        `Horoshop returned a non-JSON response (HTTP ${res.status}) from ${url}. ` +
          `Check that the domain is a Horoshop store and that the API is enabled.`,
        raw.slice(0, 500),
      );
    }
    return { httpStatus: res.status, parsed, raw };
  }

  /** Logs in and caches the token. Concurrent callers await the same request. */
  private async authenticate(): Promise<string> {
    if (this.pendingAuth) return this.pendingAuth;

    this.pendingAuth = (async () => {
      const { parsed } = await this.post(this.endpoint('auth'), {
        login: this.config.login,
        password: this.config.password,
      });
      const envelope = (parsed ?? {}) as ApiEnvelope;
      const response = (envelope.response ?? {}) as Record<string, unknown>;
      const token = typeof response.token === 'string' ? response.token : null;

      if (envelope.status !== 'OK' || !token) {
        const message = typeof response.message === 'string' ? response.message : String(envelope.status);
        throw new HoroshopError(
          `Horoshop rejected the credentials for ${this.config.domain}: ${message}. ` +
            `HOROSHOP_LOGIN and HOROSHOP_PASSWORD must belong to an admin account created ` +
            `under Налаштування → Адміни.`,
        );
      }

      this.token = token;
      this.tokenExpiresAt = Date.now() + TOKEN_TTL_MS - TOKEN_SLACK_MS;
      return token;
    })();

    try {
      return await this.pendingAuth;
    } finally {
      this.pendingAuth = null;
    }
  }

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    return this.authenticate();
  }

  /**
   * Calls an API function. Retries once on an auth failure, since the token can expire
   * between the check above and the request landing.
   */
  async call(fn: string, params: Record<string, unknown> = {}): Promise<ApiResult> {
    const url = this.endpoint(fn);
    let token = await this.getToken();
    let { httpStatus, parsed } = await this.post(url, { token, ...params });

    if (this.isAuthFailure(parsed)) {
      this.token = null;
      token = await this.authenticate();
      ({ httpStatus, parsed } = await this.post(url, { token, ...params }));
    }

    return this.toResult(fn, httpStatus, parsed);
  }

  private isAuthFailure(parsed: unknown): boolean {
    const status = (parsed as ApiEnvelope | null)?.status;
    return typeof status === 'string' && AUTH_FAILURE_STATUSES.has(status);
  }

  private toResult(fn: string, httpStatus: number, parsed: unknown): ApiResult {
    const body = (parsed ?? {}) as ApiEnvelope;

    // hooks/subscribe answers {"id": 1} with HTTP 201 and hooks/unSubscribe answers HTTP 410 —
    // neither is wrapped in the standard envelope.
    if (typeof body.status !== 'string') {
      const ok = httpStatus >= 200 && httpStatus < 300;
      // 410 Gone is the documented success for hooks/unSubscribe.
      const gone = httpStatus === 410;
      return {
        ok: ok || gone,
        status: ok || gone ? 'OK' : 'HTTP_ERROR',
        data: body,
        message: ok || gone ? undefined : `HTTP ${httpStatus} from ${fn}`,
        httpStatus,
      };
    }

    const status = body.status;
    const response = body.response;
    const message =
      response && typeof response === 'object' && 'message' in response
        ? String((response as Record<string, unknown>).message)
        : undefined;

    return {
      ok: SUCCESS_STATUSES.has(status),
      status,
      data: response ?? null,
      message,
      httpStatus,
    };
  }
}
