#!/usr/bin/env bun
/**
 * Streaming-TTS A/B harness.
 *
 * Streams text from a local OpenAI-compatible LLM (MLX) token-by-token and feeds
 * the IDENTICAL captured stream (same text, same inter-token timing) to two
 * ElevenLabs paths, then compares audio continuity:
 *
 *   baseline   – the current pi-voice ElevenLabs provider: one REST request per
 *                sentence  →  reproduces the choppiness.
 *   streaming  – ElevenLabs stream-input WebSocket: incremental text in, one
 *                continuous audio stream out  →  the proposed smooth fix.
 *
 * Output: test/baseline.wav, test/streaming.wav + an "underrun" report (silence
 * caused by audio arriving slower than real-time playback — i.e. the choppiness,
 * quantified). On macOS it also plays each clip so you can hear the difference.
 *
 * Run:
 *   export ELEVENLABS_API_KEY=...        # or rely on ~/.pi/voice.json
 *   bun test/stream-tts.ts [both|baseline|streaming] [--no-play]
 *
 * Env overrides: LLM_BASE_URL, LLM_MODEL, ELEVENLABS_VOICE_ID, ELEVENLABS_MODEL, OUT_DIR
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { ElevenLabsTTSProvider } from "../src/tts/elevenlabs.js";
import type { TTSConfig } from "../src/types.js";

// ─── Config ──────────────────────────────────────────────────────────────
function readVoiceJson(): any {
  const p = join(homedir(), ".pi", "voice.json");
  if (existsSync(p)) { try { return JSON.parse(readFileSync(p, "utf-8")); } catch { /* ignore */ } }
  return {};
}
const VOICE_JSON = readVoiceJson();

const LLM_BASE_URL = process.env.LLM_BASE_URL ?? "http://127.0.0.1:8000/v1";
const LLM_MODEL = process.env.LLM_MODEL ?? "Qwen3.6-35B-A3B-8bit";
// MLX / OpenAI-compatible servers may require auth. bun auto-loads a .env file,
// so put `LLM_API_KEY=...` there (gitignored) instead of exporting it.
const LLM_API_KEY = process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
const EL_VOICE = process.env.ELEVENLABS_VOICE_ID ?? VOICE_JSON?.tts?.voice ?? "rachel";
const EL_MODEL = process.env.ELEVENLABS_MODEL ?? "eleven_flash_v2_5";
const OUT_DIR = process.env.OUT_DIR ?? "test";

const SAMPLE_RATE = 24000, CHANNELS = 1, BYTES_PER_SAMPLE = 2;
const BYTES_PER_MS = (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE) / 1000; // 48

// --fast replays tokens with no delay (simulates a fast cloud LLM, where text
// outruns synthesis — the condition that actually makes the REST path choppy).
const FAST = process.argv.includes("--fast");
const PROMPT = process.env.TTS_PROMPT ??
  "Write a single vivid paragraph of about five sentences describing sunrise over " +
  "a quiet mountain lake. Plain prose only — no markdown, no lists, no preamble. /no_think";

// ─── Secrets / voice ─────────────────────────────────────────────────────
function getKey(): string {
  const k = process.env.ELEVENLABS_API_KEY ?? VOICE_JSON?.apiKeys?.elevenlabs;
  if (k) return k as string;
  throw new Error("No ElevenLabs key: set ELEVENLABS_API_KEY or configure ~/.pi/voice.json");
}

function resolveVoiceId(v: string): string {
  const map: Record<string, string> = {
    rachel: "21m00Tcm4TlvDq8ikWAM", drew: "29vD33N1CtxCmqQRPOHJ", clyde: "2EiwWnXFnvU5JabPnv8n",
    paul: "5Q0t7uMcjvnagumLfvZi", domi: "AZnzlk1XvdvUeBnXmlld", dave: "CYw3kZ02Hs0563khs1Fj",
    fin: "D38z5RcWu1voky8WS1ja", sarah: "EXAVITQu4vr4xnSDxMaL", adam: "pNInz6obpgDQGcFmaJgB",
    antoni: "ErXwobaYiN019PkySvjV",
  };
  return map[v.toLowerCase()] ?? v;
}

// ─── LLM token stream (OpenAI-compatible SSE) ────────────────────────────
async function* streamLLM(prompt: string): AsyncGenerator<string> {
  const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(LLM_API_KEY ? { Authorization: `Bearer ${LLM_API_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: "system", content: "You are a concise writer. Output only the requested prose." },
        { role: "user", content: prompt },
      ],
      stream: true,
      temperature: 0.8,
      max_tokens: 400,
    }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`LLM ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        const j = JSON.parse(data);
        const delta: string = j.choices?.[0]?.delta?.content ?? "";
        if (delta) yield delta;
      } catch { /* keep-alive / partial */ }
    }
  }
}

// Streaming-safe stripper for Qwen <think>…</think> spans (in case /no_think is ignored).
function makeThinkStripper() {
  let inThink = false, hold = "";
  const OPEN = "<think>", CLOSE = "</think>";
  const tail = (s: string, tag: string): number => {
    for (let k = Math.min(s.length, tag.length - 1); k > 0; k--) {
      if (tag.startsWith(s.slice(s.length - k))) return k;
    }
    return 0;
  };
  return (chunk: string): string => {
    let s = hold + chunk; hold = ""; let out = "";
    while (s.length) {
      if (!inThink) {
        const i = s.indexOf(OPEN);
        if (i === -1) { const k = tail(s, OPEN); out += s.slice(0, s.length - k); hold = s.slice(s.length - k); break; }
        out += s.slice(0, i); s = s.slice(i + OPEN.length); inThink = true;
      } else {
        const j = s.indexOf(CLOSE);
        if (j === -1) { hold = s.slice(s.length - tail(s, CLOSE)); break; }
        s = s.slice(j + CLOSE.length); inThink = false;
      }
    }
    return out;
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Tok { tok: string; dt: number }

async function captureTokens(): Promise<{ toks: Tok[]; text: string }> {
  const strip = makeThinkStripper();
  const toks: Tok[] = [];
  let last = performance.now(), text = "";
  for await (const raw of streamLLM(PROMPT)) {
    const tok = strip(raw);
    const now = performance.now();
    if (!tok) { last = now; continue; }
    toks.push({ tok, dt: now - last });
    last = now; text += tok;
    process.stdout.write(tok);
  }
  return { toks, text };
}

// Replay the captured tokens with their original inter-token delays, so both
// backends receive an identical, realistic stream.
async function* replay(toks: Tok[]): AsyncGenerator<string> {
  for (const { tok, dt } of toks) { if (!FAST && dt > 0) await sleep(dt); yield tok; }
}

// ─── Audio out ───────────────────────────────────────────────────────────
function writeWav(path: string, pcm: Buffer): void {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(CHANNELS, 22); h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE, 28);
  h.writeUInt16LE(CHANNELS * BYTES_PER_SAMPLE, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  writeFileSync(path, Buffer.concat([h, pcm]));
}

async function playWav(path: string): Promise<void> {
  if (process.platform !== "darwin") return;
  await new Promise<void>((resolve) => {
    const p = spawn("play", ["-q", path], { stdio: "ignore" });
    p.on("close", () => resolve());
    p.on("error", () => resolve());
  });
}

interface Mark { t: number; bytes: number }

// Quantify choppiness: walk audio arrivals and sum the time the playback buffer
// would have been empty (arrived slower than real-time) after the first chunk.
function analyze(marks: Mark[]) {
  if (!marks.length) return { chunks: 0, firstMs: 0, audioMs: 0, wallMs: 0, underrunMs: 0, underruns: 0 };
  const firstMs = marks[0].t;
  let cum = 0, underrunMs = 0, underruns = 0;
  for (const m of marks) {
    const playhead = m.t - firstMs;
    if (playhead > cum + 1) { underrunMs += playhead - cum; underruns++; }
    cum += m.bytes / BYTES_PER_MS;
  }
  return { chunks: marks.length, firstMs, audioMs: cum, wallMs: marks[marks.length - 1].t - firstMs, underrunMs, underruns };
}

function report(label: string, a: ReturnType<typeof analyze>): void {
  console.log(`  ${label}`);
  console.log(`    audio chunks:       ${a.chunks}`);
  console.log(`    time to 1st audio:  ${a.firstMs.toFixed(0)} ms`);
  console.log(`    audio duration:     ${(a.audioMs / 1000).toFixed(2)} s`);
  console.log(`    gaps (underruns):   ${a.underruns}  totaling ${a.underrunMs.toFixed(0)} ms`);
}

// ─── Backend 1: existing provider (REST per sentence) ────────────────────
async function runBaseline(toks: Tok[]): Promise<{ pcm: Buffer; marks: Mark[] }> {
  if (!process.env.ELEVENLABS_API_KEY) process.env.ELEVENLABS_API_KEY = getKey();
  const provider = new ElevenLabsTTSProvider();
  const cfg: TTSConfig = {
    provider: "elevenlabs", triggerMode: "always", voice: EL_VOICE, speed: 1,
    codeBlockBehavior: "announce", toolCallBehavior: "announce", thinkingBehavior: "announce",
    interruptBehavior: "fade", fadeDurationMs: 500,
    providerOptions: { elevenlabs: { model_id: EL_MODEL } },
  };
  await provider.initialize(cfg);
  const chunks: Buffer[] = [], marks: Mark[] = [];
  const start = performance.now();
  provider.on("audioChunk", (c: any) => { chunks.push(c.audio); marks.push({ t: performance.now() - start, bytes: c.audio.length }); });
  provider.on("error", (e: any) => console.error("    [baseline error]", e.message));
  await provider.speakStreaming(replay(toks));
  return { pcm: Buffer.concat(chunks), marks };
}

// ─── Backend 2: ElevenLabs stream-input WebSocket ────────────────────────
async function runStreaming(toks: Tok[]): Promise<{ pcm: Buffer; marks: Mark[] }> {
  const key = getKey();
  const url = `wss://api.elevenlabs.io/v1/text-to-speech/${resolveVoiceId(EL_VOICE)}/stream-input` +
    `?model_id=${EL_MODEL}&output_format=pcm_24000`;
  const ws = new WebSocket(url);
  const chunks: Buffer[] = [], marks: Mark[] = [];
  const start = performance.now();
  let finish!: () => void;
  const finished = new Promise<void>((r) => (finish = r));

  ws.addEventListener("message", (ev: MessageEvent) => {
    if (typeof ev.data !== "string") return;
    let msg: any; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.audio) { const b = Buffer.from(msg.audio, "base64"); chunks.push(b); marks.push({ t: performance.now() - start, bytes: b.length }); }
    if (msg.isFinal) finish();
  });
  ws.addEventListener("error", (e: any) => console.error("    [ws error]", e?.message ?? "connection error"));
  ws.addEventListener("close", () => finish());

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("WebSocket connect failed")), { once: true });
  });

  // BOS: auth + voice settings, then stream tokens, then EOS (empty text).
  ws.send(JSON.stringify({ text: " ", voice_settings: { stability: 0.5, similarity_boost: 0.75 }, xi_api_key: key }));
  for await (const tok of replay(toks)) ws.send(JSON.stringify({ text: tok }));
  ws.send(JSON.stringify({ text: "" }));

  await finished;
  try { ws.close(); } catch { /* already closed */ }
  return { pcm: Buffer.concat(chunks), marks };
}

// ─── Main ────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const arg = process.argv[2];
  const mode = arg && !arg.startsWith("-") ? arg : "both";
  const doPlay = process.platform === "darwin" && !process.argv.includes("--no-play");
  mkdirSync(OUT_DIR, { recursive: true });

  console.log(`LLM: ${LLM_MODEL} @ ${LLM_BASE_URL}`);
  console.log("Streaming text from local model:\n");
  const { toks, text } = await captureTokens();
  console.log(`\n\nCaptured ${toks.length} tokens (${text.length} chars).`);
  if (!toks.length) throw new Error("LLM produced no text — check LLM_MODEL / server.");

  if (mode === "baseline" || mode === "both") {
    console.log("\n── Baseline: current provider (REST, one request per sentence) ──");
    const { pcm, marks } = await runBaseline(toks);
    const wav = join(OUT_DIR, "baseline.wav"); writeWav(wav, pcm); report("baseline", analyze(marks));
    console.log(`    wrote ${wav}`);
    if (doPlay) { console.log("    ▶ playing baseline…"); await playWav(wav); }
  }
  if (mode === "streaming" || mode === "both") {
    console.log("\n── Streaming: ElevenLabs stream-input WebSocket ──");
    const { pcm, marks } = await runStreaming(toks);
    const wav = join(OUT_DIR, "streaming.wav"); writeWav(wav, pcm); report("streaming", analyze(marks));
    console.log(`    wrote ${wav}`);
    if (doPlay) { console.log("    ▶ playing streaming…"); await playWav(wav); }
  }
  console.log("\nLower 'gaps' = smoother. The streaming path should be near-zero.");
}

main().catch((e) => { console.error("\nFATAL:", e?.message ?? e); process.exit(1); });
