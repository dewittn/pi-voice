# Deferred TTS playback improvements

Captured 2026-06-27. **Not scheduled** — recorded so the analysis isn't lost.

> Status: deliberately deferred. The plugin is stable and in daily use as a
> reading aid (TTS reads long Pi / "Professor Claude" responses aloud while
> writing). Do **not** implement these during an active writing session — they
> touch the audio path and carry regression risk for no benefit to the current
> read-aloud workflow. Revisit when (a) not mid-writing-session, and especially
> (b) if/when conversation mode gets used.

## Background: the one root cause behind all of this

Audio is pushed into `ffplay`'s stdin ~20× faster than it plays, and `ffplay`
gives no playback-position feedback. So from the writer's side, **"is it still
playing?" is unobservable** — every consumer that needs that fact is either
guessing or wrong.

**Already fixed (commit `642bcf3`, `dev`):** the speaker's stale-player recycle
used to measure idle from the last *write*, so a long response still playing got
killed when a tool call paused writes for >`RECYCLE_IDLE_MS` — the audible
"first response cuts off, second starts." Now it estimates a playback-END time
(`playbackEndsAt`, advanced by `bytes ÷ bytesPerMs` per write in
`src/audio/speaker.ts`) and only recycles once playback has actually caught up.
This is a *model* of playback position, not ground truth — which is the thread
the improvements below pull on.

The current daemon decision (keep it single-process; a standalone audio server
was considered and rejected on plugin-distribution grounds) is recorded
separately in agent memory; these items are all **in-process**.

---

## #1 — Make the speaker the source of truth for "is audio playing"

**Problem.** `isSpeaking` and `conversationCtrl.onTTSEnd()` are driven by the TTS
provider's `start`/`end` events (`src/index.ts` → `handleTTSStart`/
`handleTTSEnd`, wired to `ttsProvider.on("start"/"end")`). `elevenlabs.ts` emits
`"end"` in its `finally` the instant the **HTTP stream** is consumed — i.e. when
*synthesis* finishes, not when *playback* finishes. For a long response that's
minutes early, and it fires per coalesced batch, so `isSpeaking` flickers
throughout a response.

**Consequences.**
- Status bar shows "⚪ Idle" while audio is still playing (cosmetic).
- **Conversation mode auto-listen** (`ConversationController.onTTSEnd` →
  `startListening()` after `delayBeforeListenMs`) reopens the mic while the
  assistant is still audibly speaking → talks over itself / captures its own TTS.
  This is the real bug. It only bites in conversation mode.

**Fix.** Have the speaker emit a single `drained`/`idle` event and drive
`isSpeaking` + `onTTSEnd` off *that*. Cheapest version: a self-rearming timer on
the speaker — each write pushes `playbackEndsAt` out; when it lapses with no new
writes, emit idle. `stopTTS()`/barge-in must force-emit idle immediately so an
interrupt doesn't schedule an auto-listen. Keep `isSpeaking = true` on the TTS
`start` (first audio); only the *end* moves to the speaker.

**Value.** Fixes conversation mode and status accuracy. **Currently low** — not
using conversation mode, so today it's only the cosmetic status bar.
**Risk.** Medium — rewires the core speaking-state machine. Failure modes: mic
never reopens (idle event never fires) or still opens early; status stuck.
**Test burden.** Extend `test/recycle-cutoff.ts`-style silent-PCM harness to
assert idle fires exactly once after the buffer empties, plus a manual
conversation-mode pass.
**Do it when:** adopting conversation mode (then it's required, not optional).

## #2 — Parse `ffplay` stderr for ground-truth playback position

**Problem / opportunity.** #1 done cheaply is still an *estimate*. `ffplay`
already writes a `\r`-updated status line to stderr with the master clock (real
elapsed playback time) and `aq=` (audio still buffered) — e.g.
`   4.52 A-V: ... aq=  123KB ...`. The speaker already captures this stream
(`stderrBuffer` in `src/audio/speaker.ts`) and currently only reads it on error.
`aq` draining to ~0 after writes stop = playback genuinely done.

**Fix.** Parse the last complete status line; use the clock / `aq` to drive the
"idle" decision in #1 (and calibrate `playbackEndsAt`). This is the
"CoreAudio-grade real status without CoreAudio / without a native dependency"
answer. Falls back to the estimate where the player isn't ffplay (Linux `aplay`).

**Value.** Makes #1 *truthful* instead of *modeled*; robust against ffplay
App-Nap / clock drift that could make the pure estimate open the mic early.
**Risk.** Low — read-only observation; cannot change what's sent to ffplay, so it
can't break playback. Worst case the parser chokes on a version's format → fall
back to estimate.
**Test burden.** A parser unit test against captured `ffplay` stderr samples.
**Do it when:** doing #1 and wanting it solid, or if the #1 estimate proves too
loose in practice.

## #3 — In-process write pacing (bounded jitter buffer)

**Problem.** We fire-hose all PCM into ffplay's pipe immediately, so minutes of
audio sit buffered (in Node's writable buffer + the OS pipe + ffplay). Backpressure
is therefore meaningless as a signal, and ~10 MB of PCM can sit in Node memory.

**Fix.** Write only ~1–2 s ahead, fed via the stdin `drain` event; let the pipe's
own backpressure pace it. Then backpressure becomes a truthful "ready for more"
clock and the committed buffer stays small.

**Value.** Low for the current workflow. Truthful backpressure (we no longer need
it — the estimate works), bounded memory, and snappier `finish-sentence`/
`lower-volume` interrupt modes. Note: `immediate` barge-in is *already* instant
(it kills ffplay; buffer size is irrelevant), so the interrupt win is niche.
**Risk.** **Highest** — it changes the actual write path (the part that's
currently stable) and introduces a brand-new failure mode: **underruns →
audible gaps**, the same choppy-audio class already eliminated (see
`FORK_NOTES.md` fixes #5/#7). Needs lead-buffer tuning and shifts the timing
assumptions the estimate/recycle were built on.
**Test burden.** Highest — real-listening tests across continuous/bursty
patterns (`test/speaker-stress.ts`) to confirm no underruns.
**Recommendation:** **skip** unless a concrete pain appears (e.g. laggy
`finish-sentence` interrupts).

---

## Decision guide

- **Reading responses aloud (current use):** do nothing. The cut-off bug is
  fixed; everything else is invisible to this workflow.
- **Adopting conversation mode:** do **#1** (estimate-based, minimal), add **#2**
  for robustness. Leave **#3**.
- **Only touch #3** if interrupt latency in `finish-sentence`/`lower-volume`
  modes becomes a real complaint.

Relevant code: `src/audio/speaker.ts` (player + `playbackEndsAt`),
`src/index.ts` (`handleTTSStart`/`handleTTSEnd`, `tool_call`), `src/tts/elevenlabs.ts`
(`"end"` emit timing), `src/conversation.ts` (auto-listen).
