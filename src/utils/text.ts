/**
 * Input sanitization and small text helpers.
 * All user-supplied modal/command text passes through here before it is
 * stored or rendered.
 */

/** Unambiguous alphabet: no 0/O, no 1/I/L. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** Random verification code, e.g. "BW-7K4P9X". */
export function randomVerificationCode(prefixLen = 2, bodyLen = 6): string {
  const rand = (n: number) =>
    Array.from({ length: n }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join("");
  return `${rand(prefixLen)}-${rand(bodyLen)}`;
}

/**
 * Sanitize free-form user input:
 *  - trim, cap length
 *  - strip @everyone / @here / role-mention pings
 *  - strip control characters
 *  - collapse >4 consecutive newlines
 */
export function sanitizeInput(raw: string, maxLen = 500): string {
  let out = raw.replace(/<@&[0-9]+>/g, "").replace(/@(everyone|here|here!)/gi, "");
  out = Array.from(out)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
    })
    .join("");
  out = out.replace(/\n{5,}/g, "\n\n\n\n");
  out = out.replace(/ {2,}/g, " ");
  out = out.trim();
  return out.length > maxLen ? out.slice(0, maxLen) : out;
}

/** Lowercase alphanumeric-only slug for ticket channel names. */
export function slugify(raw: string, maxLen = 20): string {
  return raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen) || "user";
}

/** "1234" -> "000123" */
export function zeroPad(num: number, width = 6): string {
  return String(Math.max(0, Math.floor(num))).padStart(width, "0");
}

/** Format an ISO-ish or numeric string as a Date, or null. */
export function parseDateLenient(raw: string): Date | null {
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}
