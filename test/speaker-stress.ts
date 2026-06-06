#!/usr/bin/env bun
/**
 * Speaker stress test — drives the runtime audio speaker the SAME way the
 * extension does (chunked `play()` calls over time) but with a synthetic tone,
 * so it costs nothing. Isolates playback from synthesis + orchestration to
 * reproduce cut-off / restart / die behaviour.
 *
 * Run:  PI_VOICE_DEBUG=1 bun test/speaker-stress.ts [continuous|bursty]
 *   continuous — chunks delivered faster than real time (like a WS stream)
 *   bursty     — ~1s burst, then a 500ms silence gap (like REST-per-sentence);
 *                this is the suspected trigger for the player dying on drain.
 *
 * You should hear a STEADY ~6s tone. Any drop-outs / restarts = the bug.
 * With PI_VOICE_DEBUG=1 the speaker logs every spawn/close — more than one
 * spawn for a single run means it is respawning the player mid-stream.
 */
import { createAudioSpeaker } from "../src/audio/speaker.js";

const SR = 24000, SECS = 6, FREQ = 330;
const pattern = process.argv[2] ?? "continuous";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function tone(seconds: number, freq: number): Buffer {
  const n = Math.floor(SR * seconds);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / SR) * 0.25 * 32767), i * 2);
  }
  return b;
}

async function main(): Promise<void> {
  const pcm = tone(SECS, FREQ);
  const chunkMs = 50;
  const chunkBytes = Math.floor((SR * 2 * chunkMs) / 1000);
  const chunks: Buffer[] = [];
  for (let o = 0; o < pcm.length; o += chunkBytes) chunks.push(pcm.subarray(o, o + chunkBytes));

  const spk = createAudioSpeaker({ sampleRate: SR, channels: 1, bitDepth: 16 });
  console.log(`pattern=${pattern}: ${chunks.length} chunks × ${chunkMs}ms = ${SECS}s tone`);
  console.log("Expect a STEADY tone; drop-outs/restarts = bug.\n");

  if (pattern === "bursty") {
    for (let i = 0; i < chunks.length; i += 20) {
      for (const c of chunks.slice(i, i + 20)) { spk.play(c); await sleep(5); } // ~1s burst, fast
      await sleep(500); // inter-"sentence" gap: nothing written to the player
    }
  } else {
    for (const c of chunks) { spk.play(c); await sleep(30); } // faster than real time
  }

  await sleep(3500); // let playback drain
  spk.dispose();
  console.log("\ndone");
}
main();
