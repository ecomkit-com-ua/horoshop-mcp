/**
 * Configuration is read once from the environment at startup.
 *
 * Horoshop has no API keys: the credentials are a real admin login/password created in
 * Налаштування → Адміни. Use a dedicated API admin account, not a personal one.
 */

export interface Config {
  /** Bare host, no protocol, no trailing slash. */
  domain: string;
  login: string;
  password: string;
  /** https unless HOROSHOP_INSECURE_HTTP=1 — some dev stores are plain HTTP. */
  protocol: 'http' | 'https';
  timeoutMs: number;
  maxResponseBytes: number;
  /** Hide the mutating tools. Off by default. */
  readOnly: boolean;
}

class ConfigError extends Error {}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new ConfigError(
      `${name} is not set. horoshop-mcp needs HOROSHOP_DOMAIN, HOROSHOP_LOGIN and ` +
        `HOROSHOP_PASSWORD in its MCP server "env" block. The login and password are those of ` +
        `an admin account created in the Horoshop panel under Налаштування → Адміни.`,
    );
  }
  return value;
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`${name} must be a positive number, got ${JSON.stringify(raw)}.`);
  }
  return Math.floor(value);
}

function flag(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/** Accepts "shop.com.ua", "https://shop.com.ua" or "https://shop.com.ua/" alike. */
function normaliseDomain(raw: string): string {
  const withoutProtocol = raw.replace(/^[a-z]+:\/\//i, '');
  const host = withoutProtocol.replace(/\/.*$/, '').trim();
  if (!host || !host.includes('.')) {
    throw new ConfigError(
      `HOROSHOP_DOMAIN does not look like a domain: ${JSON.stringify(raw)}. ` +
        `Expected something like "myshop.com.ua".`,
    );
  }
  return host;
}

export function loadConfig(): Config {
  return {
    domain: normaliseDomain(required('HOROSHOP_DOMAIN')),
    login: required('HOROSHOP_LOGIN'),
    password: required('HOROSHOP_PASSWORD'),
    protocol: flag('HOROSHOP_INSECURE_HTTP') ? 'http' : 'https',
    timeoutMs: positiveInt('HOROSHOP_TIMEOUT_MS', 60_000),
    maxResponseBytes: positiveInt('HOROSHOP_MAX_RESPONSE_BYTES', 100_000),
    readOnly: flag('HOROSHOP_READONLY'),
  };
}

export { ConfigError };
