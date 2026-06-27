#!/usr/bin/env bun
/**
 * Regression test for the "long response cut off by a tool-call gap" bug.
 *
 * The speaker recycles a stale player after it has been idle for
 * RECYCLE_IDLE_MS. The bug was that "idle" was measured from the last *write*,
 * but writes complete ~20× faster than playback — so a player still working
 * through a big buffer looked idle and got killed mid-sentence whenever a tool
 * call paused writes for >RECYCLE_IDLE_MS. The fix measures idle from the
 * estimated playback-END time instead.
 *
 * Uses SILENT PCM (zero amplitude) so it exercises the exact write/buffer/
 * recycle path with no audible sound, and asserts on the spawn/recycle counts
 * the speaker logs to PI_VOICE_DEBUG_FILE.
 *
 * Run (env must be set before import — RECYCLE_IDLE_MS is read once at load):
 *   PI_VOICE_DEBUG=1 PI_VOICE_RECYCLE_IDLE_MS=2000 \
 *   PI_VOICE_DEBUG_FILE=/tmp/pv-recycle.log bun test/recycle-cutoff.ts <cutoff|appnap>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createAudioSpeaker } from "../src/audio/speaker.js";

const SR = 24000;
const scenario = process.argv[2] ?? "cutoff";
const LOG = process.env.PI_VOICE_DEBUG_FILE!;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** `seconds` of silent 24 kHz mono 16-bit PCM. */
const silence = (seconds: number): Buffer => Buffer.alloc(Math.floor(SR * 2 * seconds));

/** Write `seconds` of audio as 50 ms chunks delivered faster than real time. */
async function writeFast(spk: ReturnType<typeof createAudioSpeaker>, seconds: number): Promise<void> {
  const pcm = silence(seconds);
  const chunkBytes = Math.floor((SR * 2 * 50) / 1000);
  for (let o = 0; o < pcm.length; o += chunkBytes) {
    spk.play(pcm.subarray(o, o + chunkBytes));
    await sleep(5);
  }
}

function counts(): { spawn: number; recycle: number } {
  const log = readFileSync(LOG, "utf8");
  return {
    spawn: (log.match(/\[speaker\] spawn /g) ?? []).length,
    recycle: (log.match(/\[speaker\] recycle stale player /g) ?? []).length,
  };
}

async function main(): Promise<void> {
  writeFileSync(LOG, ""); // start clean
  const spk = createAudioSpeaker({ sampleRate: SR, channels: 1, bitDepth: 16 });

  let expect: { spawn: number; recycle: number };

  if (scenario === "cutoff") {
    // Long response buffered, then a >RECYCLE_IDLE_MS gap (tool call) while it is
    // STILL playing, then the next turn. The player must NOT be recycled.
    await writeFast(spk, 10); // ~10s buffered in ~1s of wall clock
    await sleep(4000);        // gap > 2s threshold, but ~5s of audio still queued
    await writeFast(spk, 2);  // next turn — triggers recycleIfStale()
    expect = { spawn: 1, recycle: 0 };
  } else {
    // Short response that fully drains, then a genuine idle gap. The player has
    // gone stale (App Nap window) and SHOULD be recycled on the next write.
    await writeFast(spk, 1);  // ~1s buffered
    await sleep(4000);        // playback drained ~3s ago (> 2s threshold)
    await writeFast(spk, 1);  // next turn — should recycle
    expect = { spawn: 2, recycle: 1 };
  }

  await sleep(500);
  spk.dispose();
  await sleep(200);

  const got = counts();
  const pass = got.spawn === expect.spawn && got.recycle === expect.recycle;
  console.log(
    `[${scenario}] expected ${JSON.stringify(expect)}  got ${JSON.stringify(got)}  => ${pass ? "PASS" : "FAIL"}`,
  );
  process.exit(pass ? 0 : 1);
}
main();
