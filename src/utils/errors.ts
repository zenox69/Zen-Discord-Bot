/**
 * Error taxonomy.
 *
 * AppError      — expected, user-facing failure (permissions, validation,
 *                 "not configured"). Reply with the friendly message.
 * RobloxApiError — RoProxy/public Roblox request failed. NEVER conflated
 *                 with "not a member": an API failure is an API failure.
 */

export class AppError extends Error {
  readonly code: string;
  readonly friendly: string;
  readonly ephemeral: boolean;
  /** Expected errors skip the error-log channel; unexpected ones never do. */
  readonly expected: boolean;

  constructor(opts: {
    code: string;
    message?: string;
    friendly?: string;
    ephemeral?: boolean;
    expected?: boolean;
  }) {
    super(opts.message ?? opts.friendly ?? opts.code);
    this.name = "AppError";
    this.code = opts.code;
    this.friendly = opts.friendly ?? opts.message ?? "❌ Something went wrong.";
    this.ephemeral = opts.ephemeral ?? true;
    this.expected = opts.expected ?? true;
  }
}

export type RobloxErrorKind = "network" | "timeout" | "http" | "invalid";

export class RobloxApiError extends Error {
  readonly kind: RobloxErrorKind;
  readonly status?: number;
  readonly endpoint: string;

  constructor(kind: RobloxErrorKind, endpoint: string, message: string, status?: number) {
    super(message);
    this.name = "RobloxApiError";
    this.kind = kind;
    this.endpoint = endpoint;
    this.status = status;
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

export function isRobloxApiError(err: unknown): err is RobloxApiError {
  return err instanceof RobloxApiError;
}
