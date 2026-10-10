const SENSITIVE_KEY = /token|secret|password|authorization|cookie|codeVerifier|database_?url/i;
const SECRET_ENV_KEYS = ["DISCORD_TOKEN", "ROBLOX_OAUTH_CLIENT_SECRET", "DATABASE_URL"];

export function redactText(value: string): string {
  let text = value;
  for (const key of SECRET_ENV_KEYS) {
    const secret = process.env[key];
    if (secret && secret.length >= 4) text = text.split(secret).join("[REDACTED]");
  }
  return text
    .replace(/\b(?:postgres(?:ql)?|https?):\/\/[^\s/@]+:[^\s/@]+@/gi, (match) => `${match.slice(0, match.indexOf("://") + 3)}[REDACTED]@`)
    .replace(/\b(Bearer|Bot)\s+[A-Za-z0-9._~+/-]+/gi, "$1 [REDACTED]")
    .replace(/([?&](?:code|state|access_token|refresh_token|client_secret|code_verifier)=)[^&#\s]*/gi, "$1[REDACTED]")
    .replace(/((?:access_token|refresh_token|client_secret|password|\.ROBLOSECURITY)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}

/** Bounded diagnostic data; never pass raw SDK request objects to console. */
export function redact(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (typeof value === "string") return redactText(value);
  if (typeof value === "bigint") return value.toString();
  if (!value || typeof value !== "object") return value;
  if (depth >= 6) return "[truncated]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    const code = "code" in value ? value.code : undefined;
    return { name: value.name, message: redactText(value.message), stack: value.stack ? redactText(value.stack) : undefined,
      ...(typeof code === "string" || typeof code === "number" ? { code: redact(code) } : {}) };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => redact(entry, seen, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, entry]) => [key, SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(entry, seen, depth + 1)]));
}
