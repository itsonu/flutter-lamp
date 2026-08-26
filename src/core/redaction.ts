/**
 * Secret redaction for runtime evidence.
 *
 * Runtime data is sensitive: HTTP headers carry bearer tokens and cookies, URIs
 * carry API keys in query strings, and developers print credentials into logs.
 * Everything the collectors capture is handed to an AI agent AND broadcast to
 * every browser watching the dashboard, so a leak here leaves the machine.
 *
 * Redaction happens at CAPTURE, not on the way out: nothing sensitive is ever
 * written to the store, so no current or future consumer — tools, dashboard,
 * session export — can leak what was never stored. That is a smaller and more
 * defensible surface than keeping raw values around behind a filter.
 *
 * Opt out with FLUTTER_LAMP_REDACT=off when you knowingly need raw values on a
 * local-only session (docs/Rules.md: privacy by default, not privacy by force).
 */

export const REDACTED = "[REDACTED]";

/** Header names that always hold a credential. */
const DENY_EXACT =
  /^(authorization|proxy-authorization|cookie|set-cookie|www-authenticate)$/i;

/** Header names that hold a credential often enough to redact by default. */
const DENY_SUBSTRING = /(token|secret|password|passwd|credential|api[-_]?key|session)/i;

/** `eyJ…` three-part JWTs, wherever they appear in free text. */
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;

/** `Bearer <token>` / `Basic <blob>` in free text. */
const SCHEME_TOKEN = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

interface Config {
  enabled: boolean;
  /** Extra header-name substrings from FLUTTER_LAMP_REDACT_EXTRA. */
  extra: RegExp[];
}

function fromEnv(): Config {
  const extra = (process.env.FLUTTER_LAMP_REDACT_EXTRA ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => new RegExp(escapeRegExp(s), "i"));
  return { enabled: process.env.FLUTTER_LAMP_REDACT !== "off", extra };
}

let config: Config = fromEnv();

/** Re-read the environment. Exposed for tests. */
export function reloadRedactionConfig(): void {
  config = fromEnv();
}

export function redactionEnabled(): boolean {
  return config.enabled;
}

export function isSensitiveName(name: string): boolean {
  if (DENY_EXACT.test(name) || DENY_SUBSTRING.test(name)) return true;
  return config.extra.some((re) => re.test(name));
}

/**
 * Replace the values of credential-bearing headers. Returns the redacted map
 * plus the names that were hit, so a consumer can show that something was
 * withheld rather than silently presenting a partial picture.
 */
export function redactHeaders(
  headers: Record<string, string> | undefined,
): { headers: Record<string, string> | undefined; redacted: string[] } {
  if (!headers || !config.enabled) return { headers, redacted: [] };
  const out: Record<string, string> = {};
  const hit: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (isSensitiveName(name)) {
      out[name] = REDACTED;
      hit.push(name);
    } else {
      out[name] = redactText(value);
    }
  }
  return { headers: out, redacted: hit };
}

/** Strip credential-shaped substrings (JWTs, `Bearer …`) out of free text. */
export function redactText(text: string): string {
  if (!config.enabled || !text) return text;
  return text.replace(JWT, REDACTED).replace(SCHEME_TOKEN, (_m, scheme) => `${scheme} ${REDACTED}`);
}

/**
 * Redact credential-bearing query parameters. Keeps the parameter name so the
 * shape of the request stays visible — `?api_key=[REDACTED]`, not `?`.
 * Falls back to the original string when the URI will not parse.
 */
export function redactUri(uri: string): string {
  if (!config.enabled || !uri) return uri;
  if (!uri.includes("?")) return uri;
  const [base, query] = splitOnce(uri, "?");
  const params = query
    .split("&")
    .map((pair) => {
      const [rawName, ...rest] = pair.split("=");
      if (rest.length === 0) return pair;
      const name = safeDecode(rawName);
      return isSensitiveName(name) ? `${rawName}=${REDACTED}` : pair;
    })
    .join("&");
  return `${base}?${params}`;
}

function splitOnce(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep);
  return i === -1 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)];
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strip the auth token out of a VM Service URI.
 *
 * `ws://127.0.0.1:62435/ik1OKnShsmc=/ws` — that path segment is a credential
 * granting full control of the running VM, `evaluate` included, which means
 * arbitrary Dart execution in the app. The host and port are useful context and
 * are kept; the token is not, and an exported session is meant to be shared.
 */
/**
 * The path segment of a VM Service URI is an auth token, and it authorises
 * `evaluate` — arbitrary Dart execution in the app.
 *
 * Deliberately NOT gated on `config.enabled`. `FLUTTER_LAMP_REDACT=off` exists
 * so a developer can see their own app's raw headers and log text; it is a
 * choice about *observed evidence*. This is not evidence, it is our own
 * connection credential, and nobody asking to see their own request headers has
 * asked to have a remote-code-execution token written into every export and
 * broadcast to every browser on the dashboard. Host and port survive, which is
 * all a reader needs to know which app was attached.
 */
export function redactVmServiceUri(uri: string | null): string | null {
  if (!uri) return uri;
  // ws://host:port/<token>/ws  ->  ws://host:port/[REDACTED]/ws
  return uri.replace(/^(wss?:\/\/[^/]+\/)([^/]+)(\/.*)?$/i, (_m, head, _token, tail) =>
    `${head}${REDACTED}${tail ?? ""}`,
  );
}
