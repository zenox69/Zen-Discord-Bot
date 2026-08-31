const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold: Level = process.env.NODE_ENV === "production" ? "info" : "debug";

function write(level: Level, args: unknown[]): void {
  if (LEVELS[level] < LEVELS[threshold]) return;
  const stamp = new Date().toISOString();
  const line = `[${stamp}] [${level.toUpperCase().padEnd(5)}]`;
  if (level === "error") console.error(line, ...args);
  else if (level === "warn") console.warn(line, ...args);
  else console.log(line, ...args);
}

export const log = {
  debug: (...args: unknown[]) => write("debug", args),
  info: (...args: unknown[]) => write("info", args),
  warn: (...args: unknown[]) => write("warn", args),
  error: (...args: unknown[]) => write("error", args),
};
