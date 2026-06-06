import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { AudioSpeaker, SpeakerOptions } from "../types.js";
import { vlog } from "../debug-log.js";

const DEFAULT_SPEAKER_OPTIONS: SpeakerOptions = {
  sampleRate: 24000,
  channels: 1,
  bitDepth: 16,
};

/** Interval (ms) at which `fadeOut` steps volume down. */
const FADE_STEP_MS = 20;

/**
 * Recycle the player process if it has sat idle at least this long (ms).
 *
 * A long-lived player left idle on macOS gets suspended (App Nap / the audio
 * output going inactive): the process stays alive but stops producing sound
 * for what's written next, until it is respawned — which is why the first
 * response after a pause came in late or silent and a restart "fixed" it.
 * Respawning on the first write after an idle gap sidesteps that entirely.
 *
 * The default sits comfortably above the gaps seen during active speech
 * (~3-4s) and well below the multi-minute pauses that triggered the bug.
 * Override with `PI_VOICE_RECYCLE_IDLE_MS`.
 */
const RECYCLE_IDLE_MS = Number(process.env.PI_VOICE_RECYCLE_IDLE_MS) || 8000;

/** Opt-in lifecycle logging (set PI_VOICE_DEBUG=1) for diagnosing playback. */
const dbg = (message: string, data?: Record<string, unknown>): void =>
  vlog("speaker", message, data);

/** Whether ffplay (ffmpeg) is installed — probed once and cached. */
let _hasFfplay: boolean | null = null;
function hasFfplay(): boolean {
  if (_hasFfplay === null) {
    try {
      _hasFfplay = spawnSync("ffplay", ["-version"], { stdio: "ignore" }).status === 0;
    } catch {
      _hasFfplay = false;
    }
  }
  return _hasFfplay;
}

// ─── Platform helpers ────────────────────────────────────────────────────

interface SpawnDescriptor {
  command: string;
  args: string[];
}

function buildSpawnDescriptor(
  opts: SpeakerOptions,
  platform: NodeJS.Platform,
): SpawnDescriptor {
  switch (platform) {
    case "linux":
      return {
        command: "aplay",
        args: [
          "-f", `S${opts.bitDepth}_LE`,
          "-r", String(opts.sampleRate),
          "-c", String(opts.channels),
          "-t", "raw",
          "-",
        ],
      };
    case "darwin":
      // sox `play -` treats a short read from a pipe as end-of-input: when fed
      // streaming chunks it plays ~0.15s, prints "Done." and exits, so the
      // speaker respawns it per chunk → the audio cut-out/restart bug. ffplay
      // streams a pipe continuously. Prefer it; fall back to sox if ffmpeg is
      // not installed (degraded — streaming TTS will be choppy without ffplay).
      if (hasFfplay()) {
        return {
          command: "ffplay",
          args: [
            "-f", `s${opts.bitDepth}le`,
            "-ar", String(opts.sampleRate),
            "-ch_layout", opts.channels === 1 ? "mono" : "stereo",
            "-nodisp",
            "-autoexit",
            "-",
          ],
        };
      }
      return {
        command: "play",
        args: [
          "-t", "raw",
          "-b", String(opts.bitDepth),
          "-e", "signed-integer",
          "-r", String(opts.sampleRate),
          "-c", String(opts.channels),
          "-",
        ],
      };
    case "win32":
      // ffplay uses -ch_layout, not -ac (which it rejects with "Option not found").
      return {
        command: "ffplay",
        args: [
          "-f", `s${opts.bitDepth}le`,
          "-ar", String(opts.sampleRate),
          "-ch_layout", opts.channels === 1 ? "mono" : "stereo",
          "-nodisp",
          "-autoexit",
          "-",
        ],
      };
    default:
      throw new Error(
        `Unsupported platform "${platform}". ` +
        "Audio playback requires Linux (aplay), macOS (play/sox), or Windows (ffplay).",
      );
  }
}

function toolInstallHint(platform: NodeJS.Platform): string {
  switch (platform) {
    case "linux":
      return 'Install ALSA utilities: sudo apt-get install alsa-utils';
    case "darwin":
      return 'Install ffmpeg (recommended, for smooth streaming) or SoX: brew install ffmpeg';
    case "win32":
      return 'Install FFmpeg (includes ffplay): choco install ffmpeg   (or download from https://ffmpeg.org)';
    default:
      return '';
  }
}

// ─── PCM volume scaling ──────────────────────────────────────────────────

/**
 * Scale every 16-bit signed sample in `buf` by `volume` (0.0 – 1.0).
 * Returns a **new** buffer — the input is not mutated.
 */
function scalePcm16(buf: Buffer, volume: number): Buffer {
  if (volume >= 1) return buf;
  if (volume <= 0) return Buffer.alloc(buf.length);

  const out = Buffer.allocUnsafe(buf.length);
  const sampleCount = Math.floor(buf.length / 2);

  for (let i = 0; i < sampleCount; i++) {
    const offset = i * 2;
    const sample = buf.readInt16LE(offset);
    // Clamp after multiplication to stay within Int16 range.
    const scaled = Math.max(-32768, Math.min(32767, Math.round(sample * volume)));
    out.writeInt16LE(scaled, offset);
  }

  // If the buffer had an odd trailing byte, copy it unchanged.
  if (buf.length % 2 !== 0) {
    out[buf.length - 1] = buf[buf.length - 1];
  }

  return out;
}

// ─── Implementation ──────────────────────────────────────────────────────

/**
 * Cross-platform audio speaker that spawns a system playback process and
 * streams raw PCM data to its stdin.
 *
 * Supports Linux (`aplay`), macOS (`play` from SoX), and Windows (`ffplay`).
 */
export function createAudioSpeaker(
  userOpts?: Partial<SpeakerOptions>,
): AudioSpeaker {
  const opts: SpeakerOptions = { ...DEFAULT_SPEAKER_OPTIONS, ...userOpts };
  const platform = process.platform;

  const emitter = new EventEmitter();
  // The returned speaker exposes no error channel, so emitting "error" with no
  // listener attached would throw and crash the host process — this is what made
  // sox's routine stderr banner fatal. Keep a no-op listener so emit() is safe.
  emitter.on("error", () => {});
  let proc: ChildProcess | null = null;
  let playing = false;
  let disposed = false;
  let volume = 1.0;
  let fadingOut = false;
  // Timestamp of the last stdin write — used to surface idle gaps (the macOS
  // App-Nap / device-idle window where a long-lived player goes unresponsive).
  let lastWriteAt = 0;

  // ── Process lifecycle ───────────────────────────────────────────────

  /**
   * Ensure a player process is running. Spawns one if necessary and
   * returns `true` on success.
   */
  function ensureProc(): boolean {
    if (disposed) return false;
    if (proc !== null && !proc.killed) return true;

    let desc: SpawnDescriptor;
    try {
      desc = buildSpawnDescriptor(opts, platform);
    } catch (err) {
      emitter.emit("error", err instanceof Error ? err : new Error(String(err)));
      return false;
    }

    try {
      proc = spawn(desc.command, desc.args, {
        stdio: ["pipe", "ignore", "pipe"],
      });
    } catch (err) {
      const hint = toolInstallHint(platform);
      const msg =
        `Failed to start "${desc.command}". Is it installed and on PATH?\n` +
        (hint ? `${hint}\n` : "") +
        (err instanceof Error ? err.message : String(err));
      emitter.emit("error", new Error(msg));
      return false;
    }

    playing = true;
    const thisProc = proc;
    dbg("spawn", { command: desc.command, pid: thisProc.pid });

    // Players write routine diagnostics to stderr (sox prints a format banner;
    // ffmpeg is chattier still). That is NOT an error, so buffer it and only
    // surface it if the process actually exits non-zero (see "close" below).
    let stderrBuffer = "";
    thisProc.stderr!.on("data", (data: Buffer) => {
      stderrBuffer += data.toString();
    });

    // Writes to the player's stdin can fail asynchronously with EPIPE when the
    // player exits or is killed mid-stream (end of response, or an interrupt).
    // Without an "error" listener Node escalates that to an uncaughtException,
    // so swallow it here — teardown is handled by the "close"/stop paths.
    thisProc.stdin?.on("error", () => {});

    thisProc.on("error", (err: Error) => {
      if (proc === thisProc) {
        playing = false;
      }
      const hint = toolInstallHint(platform);
      const msg =
        `"${desc.command}" process error: ${err.message}\n` +
        (hint || "");
      emitter.emit("error", new Error(msg));
    });

    thisProc.on("close", (code: number | null) => {
      dbg("close", {
        pid: thisProc.pid,
        code,
        killed: thisProc.killed,
        stderr: stderrBuffer.trim() || undefined,
      });
      if (proc === thisProc) {
        playing = false;
        proc = null;
      }
      // Ignore non-zero exits we caused via kill() (stop/interrupt/dispose).
      if (code && code !== 0 && !thisProc.killed) {
        const detail = stderrBuffer.trim();
        emitter.emit(
          "error",
          new Error(`[${desc.command}] exited with code ${code}${detail ? `: ${detail}` : ""}`),
        );
      }
    });

    return true;
  }

  /**
   * Kill the player if it has been idle long enough to have gone stale, so the
   * next `ensureProc()` spawns a fresh one. Safe because a process this idle
   * has already drained whatever was buffered — nothing in flight is lost.
   */
  function recycleIfStale(): void {
    if (proc === null || lastWriteAt === 0) return;
    const idle = Date.now() - lastWriteAt;
    if (idle > RECYCLE_IDLE_MS) {
      dbg("recycle stale player", { idleMs: idle, pid: proc.pid });
      killProc();
    }
  }

  function killProc(): void {
    if (proc === null) return;
    dbg("killProc", { pid: proc.pid });
    const p = proc;
    proc = null;
    playing = false;

    try {
      if (p.stdin && !p.stdin.destroyed) {
        p.stdin.end();
      }
    } catch {
      // stdin may already be closed.
    }

    if (!p.killed) {
      p.kill("SIGTERM");

      const forceKill = setTimeout(() => {
        try {
          if (!p.killed) p.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }, 500);
      forceKill.unref();
    }
  }

  /**
   * Write a buffer to the player's stdin. Applies volume scaling before
   * writing. Silently no-ops if the stream is not writable.
   */
  function writeToProc(chunk: Buffer): boolean {
    const now = Date.now();
    const gap = lastWriteAt > 0 ? now - lastWriteAt : 0;
    if (gap > 3000) {
      // First write after a long quiet period — the prime suspect window for a
      // stale player that no longer produces sound until respawned.
      dbg("resume after idle", { gapMs: gap, pid: proc?.pid ?? null, alive: proc !== null && !proc.killed });
    }
    lastWriteAt = now;

    if (proc === null || proc.stdin === null || proc.stdin.destroyed) {
      dbg("write dropped — no live stdin", { bytes: chunk.length });
      return false;
    }

    const scaled = scalePcm16(chunk, volume);
    try {
      const ok = proc.stdin.write(scaled);
      if (!ok) {
        // Repeated backpressure means the player has stopped draining the pipe
        // — i.e. it is alive but no longer playing (the stall we're hunting).
        dbg("write backpressure", { bytes: chunk.length, pid: proc.pid });
      }
      return ok;
    } catch (err) {
      // Process may have exited between the check and the write.
      dbg("write threw", { error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  // ── Public API ──────────────────────────────────────────────────────

  const speaker: AudioSpeaker = {
    /**
     * Send a single PCM audio chunk to the playback process.
     * Spawns the player process on the first call.
     */
    play(chunk: Buffer): void {
      if (disposed) return;
      recycleIfStale();
      if (!ensureProc()) return;
      writeToProc(chunk);
    },

    /**
     * Stream audio from an async iterable to the playback process.
     * Resolves when the stream is exhausted and all data has been written.
     */
    async playStream(stream: AsyncIterable<Buffer>): Promise<void> {
      if (disposed) return;
      recycleIfStale();
      if (!ensureProc()) return;

      for await (const chunk of stream) {
        if (disposed || !playing) break;

        const ok = writeToProc(chunk);

        // Back-pressure: if the write returned false, wait for drain.
        if (!ok && proc?.stdin && !proc.stdin.destroyed) {
          await new Promise<void>((resolve) => {
            const onDrain = (): void => resolve();
            // If the stream closes before draining, resolve anyway.
            const onClose = (): void => {
              proc?.stdin?.removeListener("drain", onDrain);
              resolve();
            };
            proc!.stdin!.once("drain", onDrain);
            proc!.stdin!.once("close", onClose);
          });
        }
      }

      // Signal EOF so the player can flush its buffer and exit normally.
      if (proc?.stdin && !proc.stdin.destroyed) {
        proc.stdin.end();
      }

      // Wait for the player to finish.
      if (proc !== null) {
        await new Promise<void>((resolve) => {
          if (proc === null) {
            resolve();
            return;
          }
          proc.on("close", () => resolve());
        });
      }
    },

    /** Immediately stop playback and kill the player process. */
    stop(): void {
      fadingOut = false;
      killProc();
    },

    /**
     * Gradually reduce volume to zero over `durationMs` milliseconds,
     * then stop the player.
     */
    async fadeOut(durationMs: number): Promise<void> {
      if (!playing || disposed) return;
      if (durationMs <= 0) {
        speaker.stop();
        return;
      }

      fadingOut = true;
      const startVolume = volume;
      const steps = Math.max(1, Math.floor(durationMs / FADE_STEP_MS));
      const decrement = startVolume / steps;

      for (let i = 0; i < steps; i++) {
        if (!fadingOut || disposed) break;
        volume = Math.max(0, startVolume - decrement * (i + 1));
        await new Promise<void>((r) => setTimeout(r, FADE_STEP_MS));
      }

      volume = 0;
      speaker.stop();
      // Restore volume so subsequent plays are not muted.
      volume = startVolume;
      fadingOut = false;
    },

    /**
     * Set playback volume.
     * @param v — value between 0.0 (mute) and 1.0 (full volume).
     */
    setVolume(v: number): void {
      volume = Math.max(0, Math.min(1, v));
    },

    /** Whether audio is currently being played. */
    isPlaying(): boolean {
      return playing;
    },

    /** Stop playback and release all resources. */
    dispose(): void {
      if (disposed) return;
      disposed = true;
      fadingOut = false;
      killProc();
      emitter.removeAllListeners();
    },
  };

  return speaker;
}
