# Fork notes — pi-voice (macOS fixes)

Personal fork of [vibecoder008/pi-voice](https://github.com/vibecoder008/pi-voice).
Branch: `macos-fixes`. **Work in progress — not submitted upstream.** Captured 2026-06-05.

Upstream v1.0.0 is a single squashed commit with no test suite and was evidently never
run on macOS — every bug below surfaced within ~30 minutes of real use, all in the core
audio path. These patches make it usable; they are **not** a full hardening.

## Security review (done before adopting): clean

A source + dependency audit found **no malicious behavior**:

- No install/`postinstall` scripts anywhere in the dependency tree; everything resolves
  from the npm registry with integrity hashes.
- Every network call goes to the matching provider's official API. API keys are read
  per-provider (strict allowlist) and stored in `~/.pi/voice.json` (mode `0600`). No
  secondary exfiltration, no telemetry, no obfuscation, no `shell: true`.
- Two least-known deps audited from source: `node-edge-tts` (talks only to Microsoft's
  Edge TTS endpoint) and `node-record-lpcm16` (spawns sox/arecord, no network — and is
  in fact unused by pi-voice).
- `bun audit`: one moderate advisory — `ws` CVE-2026-45736 (`<8.20.1`; lockfile pins
  `8.20.0`) — **not exploitable here** (all `ws.close()` calls are argument-free; the
  bug requires a `TypedArray` close-reason).

Conclusion: safe to use. The issues are quality/bugs, not trust.

## Fixes on this branch

| # | Symptom | Root cause | File | Fix |
|---|---------|-----------|------|-----|
| 1 | pi crashes on any TTS playback | sox `play` prints a format banner to stderr; the speaker emitted that as `"error"` on an EventEmitter with no listener → uncaughtException | `src/audio/speaker.ts` | no-op `error` listener; buffer stderr, only error on non-zero exit |
| 2 | custom ElevenLabs voice ID ignored (used "Rachel") | `resolveVoiceId` only passed through values with a hyphen & length > 20 (UUID shape); ElevenLabs IDs are 20-char, no hyphen | `src/tts/elevenlabs.ts` | map friendly names, else pass value through as a raw voice ID |
| 3 | voice input breaks on macOS (flaky) | mic stderr handler only excused 2 line-prefixes; sox's other banner lines were emitted as errors → `onError` stops listening | `src/audio/mic.ts` | buffer stderr, only error on non-zero exit |
| 4 | `write EPIPE` crash mid-playback / on interrupt | speaker wrote PCM to the player's stdin after it exited; no `error` listener on stdin → async EPIPE became uncaughtException | `src/audio/speaker.ts` | swallow stdin `error` (EPIPE) |
| 5 | choppy TTS (gaps between sentences) | each sentence was a separate ElevenLabs REST request; first-byte latency between requests = audible gaps | `src/index.ts` | coalesce all queued sentences into one request |
| 6 | same EPIPE risk in piper provider | piper writes text to stdin with no `error` listener | `src/tts/piper.ts` | swallow stdin `error` (defensive; piper untested) |

The robust pattern (buffer stderr; only treat non-zero exit as an error) already existed
in `src/tts/system.ts` and `src/tts/piper.ts` — fixes 1 and 3 just bring `speaker.ts` and
`mic.ts` in line with it.

## Known remaining issues / TODO

- **TTS still choppy on slow generation.** Coalescing (fix 5) collapses many requests into
  ~one when text outpaces speech, but with slow token generation each sentence is still a
  separate request. A truly gapless solution needs the ElevenLabs **streaming WebSocket**
  (`/v1/text-to-speech/{voice_id}/stream-input`) — i.e. implement `speakStreaming` on the
  ElevenLabs provider. Not done.
- **Untested surfaces.** Only ElevenLabs TTS + basic input were exercised on macOS. Other
  STT/TTS providers, conversation mode, wake-word, the setup wizard, and the Windows/Linux
  audio paths are unverified and may carry similar issues.
- `node-record-lpcm16` is a declared-but-unused dependency (could be removed).
- Optional: bump `ws` to ≥ 8.20.1 to clear the (non-exploitable) advisory.

## Using this fork

Set the ElevenLabs voice in `~/.pi/voice.json` (the settings panel is a preset cycler and
won't accept a custom ID):

```json
"tts": { "provider": "elevenlabs", "voice": "YOUR_20_CHAR_VOICE_ID" }
```

Install pinned to a reviewed commit:

```
pi install git:github.com/dewittn/pi-voice@<commit-sha>
```
