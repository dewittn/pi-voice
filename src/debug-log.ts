import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/**
 * Opt-in, file-based diagnostic logging.
 *
 * Enabled by setting `PI_VOICE_DEBUG=1`. Lines are appended to
 * `~/.pi/voice-debug.log` (override with `PI_VOICE_DEBUG_FILE`). Logging goes
 * to a file rather than the console so it never corrupts the TUI, and it is a
 * no-op when the env var is unset — safe to leave in place permanently.
 *
 * Format: `<ISO timestamp> [<category>] <message> {<json data>}`
 */

const ENABLED = !!process.env.PI_VOICE_DEBUG;
const LOG_PATH =
  process.env.PI_VOICE_DEBUG_FILE ?? join(homedir(), ".pi", "voice-debug.log");

let _dirEnsured = false;

function ensureDir(): void {
  if (_dirEnsured) return;
  _dirEnsured = true;
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
  } catch {
    // Best-effort: if the directory can't be created, appends will simply fail.
  }
}

/** Whether diagnostic logging is currently active. */
export function debugEnabled(): boolean {
  return ENABLED;
}

/** Path that logs are written to (for surfacing to the user). */
export function debugLogPath(): string {
  return LOG_PATH;
}

/** Append one diagnostic line. No-op unless `PI_VOICE_DEBUG` is set. */
export function vlog(
  category: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  if (!ENABLED) return;
  ensureDir();

  let line = `${new Date().toISOString()} [${category}] ${message}`;
  if (data && Object.keys(data).length > 0) {
    try {
      line += " " + JSON.stringify(data);
    } catch {
      // Non-serializable payload — skip the data rather than throw.
    }
  }

  try {
    appendFileSync(LOG_PATH, line + "\n");
  } catch {
    // Never let logging break playback.
  }
}
