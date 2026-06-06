import { getApiKey } from "../config.js";
import { redactSecrets } from "../utils.js";
import { vlog } from "../debug-log.js";
import { BaseTTSProvider } from "./base.js";
import type { TTSProviderName, TTSConfig } from "../types.js";

const SAMPLE_RATE = 24000;
const CHANNELS = 1;
const BIT_DEPTH = 16;

/** Well-known ElevenLabs voice IDs mapped to friendly names. */
const VOICE_ID_MAP: Record<string, string> = {
  rachel: "21m00Tcm4TlvDq8ikWAM",
  drew: "29vD33N1CtxCmqQRPOHJ",
  clyde: "2EiwWnXFnvU5JabPnv8n",
  paul: "5Q0t7uMcjvnagumLfvZi",
  domi: "AZnzlk1XvdvUeBnXmlld",
  dave: "CYw3kZ02Hs0563khs1Fj",
  fin: "D38z5RcWu1voky8WS1ja",
  sarah: "EXAVITQu4vr4xnSDxMaL",
  adam: "pNInz6obpgDQGcFmaJgB",
  antoni: "ErXwobaYiN019PkySvjV",
};

/**
 * ElevenLabs TTS provider.
 *
 * Uses the REST streaming endpoint (`/v1/text-to-speech/{voice_id}/stream`)
 * with `output_format=pcm_24000` to receive raw 24 kHz 16-bit mono PCM.
 */
export class ElevenLabsTTSProvider extends BaseTTSProvider {
  readonly name: TTSProviderName = "elevenlabs";
  readonly displayName = "ElevenLabs";
  readonly requiresApiKey = true;
  readonly supportedVoices = Object.keys(VOICE_ID_MAP);

  private _apiKey = "";
  private _modelId = "eleven_flash_v2_5";
  private _stability = 0.5;
  private _similarityBoost = 0.75;

  /** Resolve a friendly voice name to its ElevenLabs voice ID. */
  private resolveVoiceId(voice: string): string {
    // A known friendly name (e.g. "rachel") maps to its ID; anything else is
    // treated as a raw ElevenLabs voice ID — a 20-char alphanumeric string such
    // as a custom or cloned voice — so bring-your-own voices work. Fall back to
    // the default only when no voice was provided.
    const trimmed = voice.trim();
    return VOICE_ID_MAP[trimmed.toLowerCase()] ?? (trimmed || VOICE_ID_MAP.rachel);
  }

  async initialize(config: TTSConfig): Promise<void> {
    await super.initialize(config);

    const key = getApiKey("elevenlabs");
    if (!key) {
      throw new Error(
        "ElevenLabs API key not found. Set ELEVENLABS_API_KEY or configure via voice settings.",
      );
    }
    this._apiKey = key;

    if (!this._voice) {
      this._voice = "rachel";
    }

    const opts = config.providerOptions?.elevenlabs;
    if (opts?.model_id && typeof opts.model_id === "string") {
      this._modelId = opts.model_id;
    }
    if (typeof opts?.stability === "number") {
      this._stability = opts.stability;
    }
    if (typeof opts?.similarity_boost === "number") {
      this._similarityBoost = opts.similarity_boost;
    }
  }

  /**
   * Stream PCM audio from ElevenLabs for the given text.
   */
  async speak(text: string, signal?: AbortSignal): Promise<void> {
    if (!text.trim()) return;

    const linkedSignal = this.createLinkedAbort(signal);
    const voiceId = this.resolveVoiceId(this._voice);
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=pcm_24000`;

    this._speaking = true;
    this.emit("start");

    const startedAt = Date.now();
    let chunks = 0;
    let bytes = 0;
    let firstChunkMs = -1;
    vlog("eleven", "speak start", { chars: text.length, voiceId });

    try {
      const timeoutSignal = AbortSignal.timeout(15000);
      const combinedSignal = AbortSignal.any([linkedSignal, timeoutSignal]);

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "xi-api-key": this._apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text,
          model_id: this._modelId,
          voice_settings: {
            stability: this._stability,
            similarity_boost: this._similarityBoost,
          },
        }),
        signal: combinedSignal,
      });

      vlog("eleven", "response", { status: response.status, ok: response.ok, ms: Date.now() - startedAt });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `ElevenLabs API error ${response.status}: ${redactSecrets(body)}`,
        );
      }

      if (!response.body) {
        throw new Error("Empty response body from ElevenLabs API.");
      }

      for await (const raw of response.body as any as AsyncIterable<Uint8Array>) {
        if (linkedSignal.aborted) break;
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        chunks++;
        bytes += buf.length;
        if (firstChunkMs < 0) {
          firstChunkMs = Date.now() - startedAt;
          vlog("eleven", "first chunk", { ms: firstChunkMs, bytes: buf.length });
        }
        this.emitAudioChunk(buf, SAMPLE_RATE, CHANNELS, BIT_DEPTH);
      }

      vlog("eleven", "speak done", { chunks, bytes, ms: Date.now() - startedAt, aborted: linkedSignal.aborted });
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : String(err);
      vlog("eleven", "speak error", { error: redactSecrets(msg), aborted: linkedSignal.aborted, chunks, bytes });
      if (linkedSignal.aborted) return;
      this.emit("error", new Error(redactSecrets(msg)));
    } finally {
      this._speaking = false;
      this.emit("end");
    }
  }
}
