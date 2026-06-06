import type {
  VoiceConfig,
  STTProviderName,
  TTSProviderName,
  STTMode,
  TTSTriggerMode,
  VoiceCommandTier,
} from "../types.js";
import {
  getSTTProviders,
  getTTSProviders,
  getApiKey,
  type ProviderInfo,
} from "../config.js";
import { extractPastedText } from "../utils.js";
import { truncateToWidth, matchesKey } from "@mariozechner/pi-tui";

// Sentinel value appended to every provider's voice list. Selecting it opens
// an inline editor where the user can paste a raw voice ID (e.g. a cloned or
// custom ElevenLabs voice) instead of picking a built-in preset.
const CUSTOM_VOICE = "Custom";

// ─── Constants ──────────────────────────────────────────────────────────

const VERSION = "1.0.0";

const TAB_LABELS = ["Overview", "Input", "Output", "Commands", "Conversation", "API Keys"] as const;
type TabId = (typeof TAB_LABELS)[number];

// ─── Setting Descriptor ─────────────────────────────────────────────────

interface SettingDescriptor {
  id: string;
  label: string;
  values: string[];
  description: string;
  getCurrent: (config: VoiceConfig) => string;
  apply: (config: VoiceConfig, value: string) => void;
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Open the voice-settings overlay with a fully custom multi-tab panel.
 *
 * Changes are applied to `config` in-place, and `onConfigChange` is called
 * after every individual setting change so the caller can persist to disk.
 *
 * Resolves when the user closes the panel (Escape / q).
 */
export async function showSettingsPanel(
  ctx: any,
  config: VoiceConfig,
  onConfigChange: (config: VoiceConfig) => void,
): Promise<void> {
  await ctx.ui.custom(
    (tui: any, theme: any, _keybindings: any, done: (result: undefined) => void) => {
      // ── State ─────────────────────────────────────────────────
      let activeTab = 0;
      let selectedRow = 0;
      let scrollOffset = 0;
      let cachedLines: string[] | null = null;
      let cachedWidth = 0;

      // Inline custom-voice editor state. When `editingVoice` is true, all key
      // input is routed to the text buffer until the user confirms or cancels.
      let editingVoice = false;
      let voiceBuffer = "";

      const invalidate = () => {
        cachedLines = null;
        tui.requestRender();
      };

      // ── Tab descriptors (built lazily per render) ─────────────
      const getTabSettings = (): SettingDescriptor[] => {
        switch (activeTab) {
          case 1:
            return buildInputSettings();
          case 2:
            return buildOutputSettings(config);
          case 3:
            return buildCommandSettings();
          case 4:
            return buildConversationSettings();
          default:
            return [];
        }
      };

      // ── Custom-voice editor helpers ───────────────────────────
      // Open the inline editor, pre-filling with the current custom ID (if the
      // stored voice isn't a recognized preset) so it can be edited in place.
      const startVoiceEdit = () => {
        const isPreset = !!matchVoicePreset(config.tts.voice, config.tts.provider);
        voiceBuffer = isPreset ? "" : config.tts.voice.trim();
        editingVoice = true;
        invalidate();
      };

      // Apply a value chosen by cycling the Voice row. The "Custom" sentinel
      // opens the editor instead of being stored verbatim.
      const selectVoiceValue = (value: string) => {
        if (value === CUSTOM_VOICE) {
          startVoiceEdit();
          return;
        }
        config.tts.voice = value;
        onConfigChange(config);
        invalidate();
      };

      // Cycle the Voice row by +1/-1 through presets + "Custom".
      const cycleVoice = (delta: number) => {
        const cycle = getVoicesForProvider(config.tts.provider);
        const preset = matchVoicePreset(config.tts.voice, config.tts.provider);
        const curIdx = preset ? cycle.indexOf(preset) : cycle.indexOf(CUSTOM_VOICE);
        const next = (curIdx + delta + cycle.length) % cycle.length;
        selectVoiceValue(cycle[next]);
      };

      // Route a key to the open editor. Returns once handled.
      const handleVoiceEdit = (data: string) => {
        if (matchesKey(data, "escape")) {
          editingVoice = false;
          invalidate();
          return;
        }
        if (matchesKey(data, "enter")) {
          const id = voiceBuffer.trim();
          if (id.length > 0) {
            config.tts.voice = id;
            onConfigChange(config);
          }
          editingVoice = false;
          invalidate();
          return;
        }
        if (matchesKey(data, "backspace")) {
          if (voiceBuffer.length > 0) {
            voiceBuffer = voiceBuffer.slice(0, -1);
            invalidate();
          }
          return;
        }
        const text = extractPastedText(data);
        if (text) {
          voiceBuffer += text;
          invalidate();
        }
      };

      // ── Input handling ────────────────────────────────────────
      const handleInput = (data: string) => {
        // While editing a custom voice ID, the buffer captures every key.
        if (editingVoice) {
          handleVoiceEdit(data);
          return;
        }

        // Close
        if (matchesKey(data, "escape") || matchesKey(data, "q")) {
          done(undefined);
          return;
        }

        // Tab navigation
        if (matchesKey(data, "tab") || matchesKey(data, "right")) {
          activeTab = (activeTab + 1) % TAB_LABELS.length;
          selectedRow = 0;
          scrollOffset = 0;
          invalidate();
          return;
        }
        if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) {
          activeTab = (activeTab - 1 + TAB_LABELS.length) % TAB_LABELS.length;
          selectedRow = 0;
          scrollOffset = 0;
          invalidate();
          return;
        }

        // Number keys for direct tab access
        for (let i = 0; i < TAB_LABELS.length; i++) {
          if (matchesKey(data, String(i + 1))) {
            activeTab = i;
            selectedRow = 0;
            scrollOffset = 0;
            invalidate();
            return;
          }
        }

        // Settings navigation (tabs 1-4 have editable items)
        const items = getTabSettings();
        if (items.length > 0) {
          if (matchesKey(data, "up")) {
            selectedRow = Math.max(0, selectedRow - 1);
            invalidate();
            return;
          }
          if (matchesKey(data, "down")) {
            selectedRow = Math.min(items.length - 1, selectedRow + 1);
            invalidate();
            return;
          }

          // Value cycling
          const item = items[selectedRow];
          if (item) {
            // The Voice row supports a "Custom" entry with inline text entry,
            // so it needs special handling instead of plain value cycling.
            if (item.id === "tts.voice") {
              if (matchesKey(data, "l")) {
                cycleVoice(1);
              } else if (matchesKey(data, "h")) {
                cycleVoice(-1);
              } else if (matchesKey(data, "enter")) {
                // Enter edits when already on Custom, otherwise advances.
                if (matchVoicePreset(config.tts.voice, config.tts.provider)) {
                  cycleVoice(1);
                } else {
                  startVoiceEdit();
                }
              }
              return;
            }

            const current = item.getCurrent(config);
            const idx = item.values.indexOf(current);
            let changed = false;

            if (matchesKey(data, "l") || matchesKey(data, "enter")) {
              const next = (idx + 1) % item.values.length;
              item.apply(config, item.values[next]);
              changed = true;
            }
            if (matchesKey(data, "h")) {
              const prev = (idx - 1 + item.values.length) % item.values.length;
              item.apply(config, item.values[prev]);
              changed = true;
            }

            if (changed) {
              onConfigChange(config);
              invalidate();
              return;
            }
          }
        } else {
          // Read-only tabs: scroll with up/down
          if (matchesKey(data, "up")) {
            scrollOffset = Math.max(0, scrollOffset - 1);
            invalidate();
            return;
          }
          if (matchesKey(data, "down")) {
            scrollOffset += 1;
            invalidate();
            return;
          }
        }
      };

      // ── Render ────────────────────────────────────────────────
      const render = (width: number): string[] => {
        if (cachedLines && cachedWidth === width) return cachedLines;
        cachedWidth = width;

        const lines: string[] = [];
        const w = width;
        const inner = Math.max(20, w - 4);

        // ── Header ──────────────────────────────────────────
        lines.push("");
        lines.push(truncateToWidth(theme.fg("accent", "  " + hrLine(inner)), w));
        lines.push(truncateToWidth(
          "  " + theme.fg("accent", theme.bold(" pi-voice")) +
          theme.fg("muted", " v" + VERSION) +
          theme.fg("muted", "  |  Voice I/O for Pi"),
          w,
        ));
        lines.push(truncateToWidth(theme.fg("accent", "  " + hrLine(inner)), w));

        // ── Tab bar ─────────────────────────────────────────
        lines.push("");
        let tabBar = "  ";
        for (let i = 0; i < TAB_LABELS.length; i++) {
          const label = TAB_LABELS[i];
          const num = String(i + 1);
          if (i === activeTab) {
            tabBar += theme.bg("selectedBg", theme.fg("text", " " + num + ":" + label + " "));
          } else {
            tabBar += theme.fg("muted", " " + num + ":" + label + " ");
          }
        }
        lines.push(truncateToWidth(tabBar, w));
        lines.push(truncateToWidth(theme.fg("muted", "  " + thinLine(inner)), w));
        lines.push("");

        // ── Tab content ─────────────────────────────────────
        switch (activeTab) {
          case 0:
            renderOverviewTab(lines, w, inner, theme, config);
            break;
          case 1:
            renderSettingsTab(lines, w, inner, theme, config, buildInputSettings(), selectedRow, "Speech-to-Text Configuration");
            break;
          case 2:
            renderSettingsTab(lines, w, inner, theme, config, buildOutputSettings(config), selectedRow, "Text-to-Speech Configuration");
            break;
          case 3:
            renderCommandsTab(lines, w, inner, theme, config, buildCommandSettings(), selectedRow);
            break;
          case 4:
            renderConversationTab(lines, w, inner, theme, config, buildConversationSettings(), selectedRow);
            break;
          case 5:
            renderApiKeysTab(lines, w, inner, theme);
            break;
        }

        // ── Custom voice editor (Output tab only) ───────────
        if (editingVoice && activeTab === 2) {
          lines.push("");
          lines.push(truncateToWidth(theme.fg("muted", "  " + thinLine(inner)), w));
          lines.push("");
          lines.push(truncateToWidth("  " + theme.fg("accent", theme.bold(" Custom voice ID")), w));
          lines.push("");
          const display = voiceBuffer.length > 0
            ? theme.fg("text", voiceBuffer)
            : theme.fg("muted", "(paste your voice ID here)");
          const cursor = theme.fg("accent", "█");
          lines.push(truncateToWidth("    " + display + cursor, w));
          lines.push("");
          lines.push(truncateToWidth(
            "    " + theme.fg("dim", voiceBuffer.length + " characters  •  Enter confirm  •  Esc cancel"),
            w,
          ));
        }

        // ── Footer help bar ─────────────────────────────────
        lines.push("");
        lines.push(truncateToWidth(theme.fg("muted", "  " + thinLine(inner)), w));

        const isSettingsTab = activeTab >= 1 && activeTab <= 4;
        const helpItems: string[] = [];
        if (editingVoice) {
          helpItems.push("Type or paste voice ID");
          helpItems.push("Enter confirm");
          helpItems.push("Esc cancel");
        } else {
          helpItems.push("Tab/Shift+Tab switch tabs");
          helpItems.push("1-6 jump to tab");
          if (isSettingsTab) {
            helpItems.push("Up/Down navigate");
            helpItems.push("h/l or Enter change value");
          } else {
            helpItems.push("Up/Down scroll");
          }
          helpItems.push("Esc/q close");
        }
        lines.push(truncateToWidth(
          "  " + theme.fg("dim", " " + helpItems.join("  |  ")),
          w,
        ));
        lines.push("");

        cachedLines = lines;
        return lines;
      };

      return {
        render,
        invalidate() { cachedLines = null; },
        handleInput,
      };
    },
    { overlay: true },
  );
}

// ─── Tab Renderers ──────────────────────────────────────────────────────

function renderOverviewTab(
  lines: string[],
  w: number,
  inner: number,
  theme: any,
  config: VoiceConfig,
): void {
  // ── Status Summary ──────────────────────────────────────────────
  lines.push(truncateToWidth("  " + theme.fg("accent", theme.bold(" Current Status")), w));
  lines.push("");

  const sttProviders = getSTTProviders();
  const ttsProviders = getTTSProviders();
  const sttInfo = sttProviders.find((p) => p.name === config.stt.provider);
  const ttsInfo = ttsProviders.find((p) => p.name === config.tts.provider);

  const sttDot = sttInfo?.isAvailable ? theme.fg("success", "\u25CF") : theme.fg("warning", "\u25CF");
  const ttsDot = ttsInfo?.isAvailable ? theme.fg("success", "\u25CF") : theme.fg("warning", "\u25CF");
  const convDot = config.conversation.enabled ? theme.fg("success", "\u25CF") : theme.fg("muted", "\u25CB");
  const cmdDot = config.voiceCommands.enabled ? theme.fg("success", "\u25CF") : theme.fg("muted", "\u25CB");

  lines.push(truncateToWidth(
    "    " + sttDot + theme.fg("muted", " STT: ") +
    theme.fg("text", (sttInfo?.displayName ?? config.stt.provider)) +
    theme.fg("muted", "  |  Mode: ") + theme.fg("text", config.stt.mode),
    w,
  ));
  lines.push(truncateToWidth(
    "    " + ttsDot + theme.fg("muted", " TTS: ") +
    theme.fg("text", (ttsInfo?.displayName ?? config.tts.provider)) +
    theme.fg("muted", "  |  Trigger: ") + theme.fg("text", config.tts.triggerMode),
    w,
  ));
  lines.push(truncateToWidth(
    "    " + convDot + theme.fg("muted", " Conversation mode: ") +
    theme.fg("text", config.conversation.enabled ? "On" : "Off"),
    w,
  ));
  lines.push(truncateToWidth(
    "    " + cmdDot + theme.fg("muted", " Voice commands: ") +
    theme.fg("text", config.voiceCommands.enabled ? "On (" + config.voiceCommands.tier + ")" : "Off"),
    w,
  ));

  // ── Keybindings ─────────────────────────────────────────────────
  lines.push("");
  lines.push(truncateToWidth("  " + theme.fg("accent", theme.bold(" Keybindings")), w));
  lines.push("");

  const bindings = [
    [config.keybindings.toggleMic, "Toggle microphone on/off"],
    [config.keybindings.muteTTS, "Mute / unmute TTS playback"],
    [config.keybindings.pushToTalk, "Push-to-talk (hold to record)"],
  ];
  for (const [key, desc] of bindings) {
    lines.push(truncateToWidth(
      "    " + theme.fg("accent", padRight(key, 14)) + theme.fg("text", desc),
      w,
    ));
  }

  // ── Slash Commands ──────────────────────────────────────────────
  lines.push("");
  lines.push(truncateToWidth("  " + theme.fg("accent", theme.bold(" Slash Commands")), w));
  lines.push("");

  const cmds: [string, string][] = [
    ["/voice", "Show voice status overview"],
    ["/voice settings", "Open this settings panel"],
    ["/voice setup", "Re-run the setup wizard"],
    ["/voice start", "Start listening (mic on)"],
    ["/voice stop", "Stop listening (mic off)"],
    ["/voice mute", "Mute TTS output"],
    ["/voice unmute", "Unmute TTS output"],
    ["/voice say <text>", "Speak arbitrary text via TTS"],
    ["/voice conv on|off", "Toggle conversation mode"],
    ["/voice key <prov> <key>", "Set an API key for a provider"],
  ];
  for (const [cmd, desc] of cmds) {
    lines.push(truncateToWidth(
      "    " + theme.fg("accent", padRight(cmd, 26)) + theme.fg("muted", desc),
      w,
    ));
  }

  // ── Features ────────────────────────────────────────────────────
  lines.push("");
  lines.push(truncateToWidth("  " + theme.fg("accent", theme.bold(" Features")), w));
  lines.push("");

  const features = [
    "7 speech-to-text providers with real-time streaming",
    "9 text-to-speech providers including free options",
    "Conversation mode: speak, listen, repeat",
    "Voice commands: dictate punctuation, run /commands, navigate",
    "Interim results for live transcription feedback",
    "Smart TTS: skip code blocks, summarize tool calls",
    "Configurable interrupt behavior for TTS playback",
  ];
  for (const feat of features) {
    lines.push(truncateToWidth("    " + theme.fg("muted", "\u2022 ") + theme.fg("text", feat), w));
  }
}

function renderSettingsTab(
  lines: string[],
  w: number,
  _inner: number,
  theme: any,
  config: VoiceConfig,
  settings: SettingDescriptor[],
  selectedRow: number,
  title: string,
): void {
  lines.push(truncateToWidth("  " + theme.fg("accent", theme.bold(" " + title)), w));
  lines.push("");

  for (let i = 0; i < settings.length; i++) {
    const s = settings[i];
    const current = s.getCurrent(config);
    const isFocused = i === selectedRow;

    if (isFocused) {
      const arrow = theme.fg("accent", "\u25B6");
      const label = theme.fg("text", theme.bold(s.label));
      const valDisplay = theme.fg("accent", " \u25C0 " + current + " \u25B6 ");
      lines.push(truncateToWidth("  " + arrow + " " + label + "  " + valDisplay, w));
      lines.push(truncateToWidth("    " + theme.fg("dim", s.description), w));
    } else {
      const dot = theme.fg("muted", "\u25CB");
      const label = theme.fg("muted", s.label);
      const val = theme.fg("text", current);
      lines.push(truncateToWidth("  " + dot + " " + label + "  " + val, w));
    }
    lines.push("");
  }
}

function renderCommandsTab(
  lines: string[],
  w: number,
  inner: number,
  theme: any,
  config: VoiceConfig,
  settings: SettingDescriptor[],
  selectedRow: number,
): void {
  // Render settings first
  renderSettingsTab(lines, w, inner, theme, config, settings, selectedRow, "Voice Command Settings");

  // Then show the reference table
  lines.push(truncateToWidth(theme.fg("muted", "  " + thinLine(inner)), w));
  lines.push("");
  lines.push(truncateToWidth("  " + theme.fg("accent", theme.bold(" Command Reference")), w));
  lines.push(truncateToWidth("    " + theme.fg("dim", "Active tier: " + config.voiceCommands.tier), w));
  lines.push("");

  const tier = config.voiceCommands.tier;
  const commandGroups = getCommandReference(tier);

  for (const group of commandGroups) {
    lines.push(truncateToWidth("    " + theme.fg("accent", group.name), w));
    for (const cmd of group.commands) {
      lines.push(truncateToWidth(
        "      " + theme.fg("text", padRight(cmd.phrase, 22)) + theme.fg("muted", cmd.action),
        w,
      ));
    }
    lines.push("");
  }
}

function renderConversationTab(
  lines: string[],
  w: number,
  inner: number,
  theme: any,
  config: VoiceConfig,
  settings: SettingDescriptor[],
  selectedRow: number,
): void {
  renderSettingsTab(lines, w, inner, theme, config, settings, selectedRow, "Conversation Mode");

  lines.push(truncateToWidth(theme.fg("muted", "  " + thinLine(inner)), w));
  lines.push("");
  lines.push(truncateToWidth("  " + theme.fg("accent", theme.bold(" How Conversation Mode Works")), w));
  lines.push("");

  const steps = [
    ["1.", "You speak into the microphone (STT transcribes)"],
    ["2.", "Transcription is sent as a prompt to the AI"],
    ["3.", "AI response is read aloud via TTS"],
    ["4.", "After TTS finishes, mic auto-activates to listen again"],
    ["5.", "The loop continues until you stop it"],
  ];
  for (const [num, desc] of steps) {
    lines.push(truncateToWidth(
      "    " + theme.fg("accent", padRight(num, 4)) + theme.fg("text", desc),
      w,
    ));
  }

  lines.push("");
  lines.push(truncateToWidth(
    "    " + theme.fg("dim", "Tip: Use Alt+V to break the loop, or say \"stop listening\"."),
    w,
  ));
}

function renderApiKeysTab(
  lines: string[],
  w: number,
  inner: number,
  theme: any,
): void {
  lines.push(truncateToWidth("  " + theme.fg("accent", theme.bold(" API Key Status")), w));
  lines.push("");

  const envMap: Record<string, string> = {
    deepgram: "DEEPGRAM_API_KEY",
    openai: "OPENAI_API_KEY",
    azure: "AZURE_SPEECH_KEY",
    google: "GOOGLE_APPLICATION_CREDENTIALS",
    assemblyai: "ASSEMBLYAI_API_KEY",
    elevenlabs: "ELEVENLABS_API_KEY",
    cartesia: "CARTESIA_API_KEY",
  };

  // Collect unique providers from both STT and TTS
  const sttProviders = getSTTProviders();
  const ttsProviders = getTTSProviders();

  const seen = new Set<string>();
  const allProviders: Array<{ name: string; displayName: string; requiresKey: boolean; hasKey: boolean; usedBy: string }> = [];

  for (const p of sttProviders) {
    seen.add(p.name);
    allProviders.push({
      name: p.name,
      displayName: p.displayName,
      requiresKey: p.requiresApiKey,
      hasKey: p.hasApiKey,
      usedBy: "STT",
    });
  }
  for (const p of ttsProviders) {
    if (seen.has(p.name)) {
      const existing = allProviders.find((a) => a.name === p.name);
      if (existing) existing.usedBy = "STT + TTS";
      continue;
    }
    seen.add(p.name);
    allProviders.push({
      name: p.name,
      displayName: p.displayName,
      requiresKey: p.requiresApiKey,
      hasKey: p.hasApiKey,
      usedBy: "TTS",
    });
  }

  // Header row
  lines.push(truncateToWidth(
    "    " +
    theme.fg("muted", padRight("Provider", 22)) +
    theme.fg("muted", padRight("Status", 16)) +
    theme.fg("muted", "Used By"),
    w,
  ));
  lines.push(truncateToWidth("    " + theme.fg("muted", thinLine(Math.min(inner - 4, 60))), w));

  for (const p of allProviders) {
    let statusText: string;
    if (!p.requiresKey) {
      statusText = theme.fg("success", "\u2605 Free");
    } else if (p.hasKey) {
      statusText = theme.fg("success", "\u2713 Set");
    } else {
      statusText = theme.fg("error", "\u2717 Missing");
    }

    lines.push(truncateToWidth(
      "    " +
      theme.fg("text", padRight(p.displayName, 22)) +
      padRight(statusText, 16 + ansiOverhead(statusText)) +
      theme.fg("muted", p.usedBy),
      w,
    ));
  }

  // Environment variable reference
  lines.push("");
  lines.push(truncateToWidth(theme.fg("muted", "  " + thinLine(inner)), w));
  lines.push("");
  lines.push(truncateToWidth("  " + theme.fg("accent", theme.bold(" Setting API Keys")), w));
  lines.push("");
  lines.push(truncateToWidth("    " + theme.fg("text", "Option 1: ") + theme.fg("muted", "Environment variable"), w));
  lines.push("");

  for (const [prov, envVar] of Object.entries(envMap)) {
    lines.push(truncateToWidth(
      "      " + theme.fg("muted", padRight(prov, 14)) + theme.fg("accent", envVar),
      w,
    ));
  }

  lines.push("");
  lines.push(truncateToWidth("    " + theme.fg("text", "Option 2: ") + theme.fg("muted", "Slash command"), w));
  lines.push(truncateToWidth("      " + theme.fg("accent", "/voice key <provider> <your-api-key>"), w));
  lines.push("");
  lines.push(truncateToWidth("    " + theme.fg("text", "Option 3: ") + theme.fg("muted", "Setup wizard"), w));
  lines.push(truncateToWidth("      " + theme.fg("accent", "/voice setup"), w));
  lines.push("");
  lines.push(truncateToWidth(
    "    " + theme.fg("dim", "Keys are stored in ~/.pi/voice.json with mode 0600."),
    w,
  ));
}

// ─── Settings Builders ──────────────────────────────────────────────────

function buildInputSettings(): SettingDescriptor[] {
  const sttProviders = getSTTProviders();

  return [
    {
      id: "stt.provider",
      label: "Provider",
      values: sttProviders.map((p) => p.name),
      description: describeSTTProvider(sttProviders),
      getCurrent: (c) => c.stt.provider,
      apply: (c, v) => { c.stt.provider = v as STTProviderName; },
    },
    {
      id: "stt.mode",
      label: "Input Mode",
      values: ["push-to-talk", "toggle", "wake-word", "vad"],
      description: "push-to-talk: hold key | toggle: press on/off | wake-word: say trigger | vad: auto-detect speech",
      getCurrent: (c) => c.stt.mode,
      apply: (c, v) => { c.stt.mode = v as STTMode; },
    },
    {
      id: "stt.autoSend",
      label: "Auto-send",
      values: ["on", "off"],
      description: "Automatically submit transcribed text as a prompt when you stop speaking",
      getCurrent: (c) => c.stt.autoSend ? "on" : "off",
      apply: (c, v) => { c.stt.autoSend = v === "on"; },
    },
    {
      id: "stt.interimResults",
      label: "Interim Results",
      values: ["on", "off"],
      description: "Show partial transcription in real time while you speak",
      getCurrent: (c) => c.stt.interimResults ? "on" : "off",
      apply: (c, v) => { c.stt.interimResults = v === "on"; },
    },
  ];
}

function buildOutputSettings(config: VoiceConfig): SettingDescriptor[] {
  const ttsProviders = getTTSProviders();

  return [
    {
      id: "tts.provider",
      label: "Provider",
      values: ttsProviders.map((p) => p.name),
      description: describeTTSProvider(ttsProviders),
      getCurrent: (c) => c.tts.provider,
      apply: (c, v) => { c.tts.provider = v as TTSProviderName; },
    },
    {
      id: "tts.triggerMode",
      label: "Trigger Mode",
      values: ["always", "voice-mode", "manual"],
      description: "always: read all responses | voice-mode: only after voice input | manual: /voice say only",
      getCurrent: (c) => c.tts.triggerMode,
      apply: (c, v) => { c.tts.triggerMode = v as TTSTriggerMode; },
    },
    {
      id: "tts.voice",
      label: "Voice",
      values: getVoicesForProvider(config.tts.provider),
      description: "Voice preset for the active provider — pick \"Custom\" to paste a voice ID",
      getCurrent: (c) => voiceDisplay(c.tts.voice, c.tts.provider),
      apply: (c, v) => { c.tts.voice = v; },
    },
    {
      id: "tts.speed",
      label: "Speed",
      values: ["0.5", "0.75", "1", "1.25", "1.5", "2"],
      description: "Playback speed multiplier (1 = normal)",
      getCurrent: (c) => String(c.tts.speed),
      apply: (c, v) => { c.tts.speed = parseFloat(v); },
    },
    {
      id: "tts.codeBlockBehavior",
      label: "Code Blocks",
      values: ["skip", "announce", "read"],
      description: "skip: silence | announce: say \"code block\" | read: read the code aloud",
      getCurrent: (c) => c.tts.codeBlockBehavior,
      apply: (c, v) => { c.tts.codeBlockBehavior = v as VoiceConfig["tts"]["codeBlockBehavior"]; },
    },
    {
      id: "tts.toolCallBehavior",
      label: "Tool Calls",
      values: ["skip", "announce", "announce-and-summarize"],
      description: "skip: silence | announce: say tool name | summarize: name + brief result",
      getCurrent: (c) => c.tts.toolCallBehavior,
      apply: (c, v) => { c.tts.toolCallBehavior = v as VoiceConfig["tts"]["toolCallBehavior"]; },
    },
    {
      id: "tts.thinkingBehavior",
      label: "Thinking",
      values: ["skip", "announce", "read"],
      description: "How to handle the AI's thinking/reasoning blocks",
      getCurrent: (c) => c.tts.thinkingBehavior,
      apply: (c, v) => { c.tts.thinkingBehavior = v as VoiceConfig["tts"]["thinkingBehavior"]; },
    },
    {
      id: "tts.interruptBehavior",
      label: "Interrupt",
      values: ["immediate", "fade", "finish-sentence", "lower-volume"],
      description: "What happens when you start speaking while TTS is playing",
      getCurrent: (c) => c.tts.interruptBehavior,
      apply: (c, v) => { c.tts.interruptBehavior = v as VoiceConfig["tts"]["interruptBehavior"]; },
    },
    {
      id: "tts.interruptOnInput",
      label: "Interrupt on New Input",
      values: ["on", "off"],
      description: "Submit a new prompt while speaking: on = stop & read the new one | off = finish current, then queue",
      getCurrent: (c) => c.tts.interruptOnInput ? "on" : "off",
      apply: (c, v) => { c.tts.interruptOnInput = v === "on"; },
    },
  ];
}

function buildCommandSettings(): SettingDescriptor[] {
  return [
    {
      id: "voiceCommands.enabled",
      label: "Enabled",
      values: ["on", "off"],
      description: "Intercept spoken phrases as commands (e.g. \"new line\", \"undo that\")",
      getCurrent: (c) => c.voiceCommands.enabled ? "on" : "off",
      apply: (c, v) => { c.voiceCommands.enabled = v === "on"; },
    },
    {
      id: "voiceCommands.tier",
      label: "Command Tier",
      values: ["basic", "pi-commands", "navigation", "all"],
      description: "basic: punctuation | +pi-commands: /slash cmds | +navigation: scroll/model | all: everything",
      getCurrent: (c) => c.voiceCommands.tier,
      apply: (c, v) => { c.voiceCommands.tier = v as VoiceCommandTier; },
    },
  ];
}

function buildConversationSettings(): SettingDescriptor[] {
  return [
    {
      id: "conversation.enabled",
      label: "Enabled",
      values: ["on", "off"],
      description: "Enable continuous speak-listen-respond loop",
      getCurrent: (c) => c.conversation.enabled ? "on" : "off",
      apply: (c, v) => { c.conversation.enabled = v === "on"; },
    },
    {
      id: "conversation.autoListenAfterTTS",
      label: "Auto-listen after TTS",
      values: ["on", "off"],
      description: "Automatically start listening when TTS finishes speaking",
      getCurrent: (c) => c.conversation.autoListenAfterTTS ? "on" : "off",
      apply: (c, v) => { c.conversation.autoListenAfterTTS = v === "on"; },
    },
    {
      id: "conversation.delayBeforeListenMs",
      label: "Delay Before Listen",
      values: ["0ms", "250ms", "500ms", "1000ms"],
      description: "Pause after TTS ends before activating the microphone",
      getCurrent: (c) => c.conversation.delayBeforeListenMs + "ms",
      apply: (c, v) => { c.conversation.delayBeforeListenMs = parseInt(v, 10); },
    },
  ];
}

// ─── Voice Command Reference Data ───────────────────────────────────────

interface CommandGroup {
  name: string;
  tier: VoiceCommandTier;
  commands: Array<{ phrase: string; action: string }>;
}

function getCommandReference(activeTier: VoiceCommandTier): CommandGroup[] {
  const tiers: VoiceCommandTier[] = ["basic", "pi-commands", "navigation", "all"];
  const activeIdx = tiers.indexOf(activeTier);

  const groups: CommandGroup[] = [
    {
      name: "Basic (punctuation & editing)",
      tier: "basic",
      commands: [
        { phrase: "period / full stop", action: "Insert ." },
        { phrase: "comma", action: "Insert ," },
        { phrase: "question mark", action: "Insert ?" },
        { phrase: "exclamation mark", action: "Insert !" },
        { phrase: "new line", action: "Insert newline" },
        { phrase: "new paragraph", action: "Insert double newline" },
        { phrase: "send / submit", action: "Submit prompt" },
        { phrase: "cancel", action: "Clear input" },
        { phrase: "undo / undo that", action: "Undo last edit" },
        { phrase: "delete word", action: "Delete last word" },
        { phrase: "select all", action: "Select all text" },
      ],
    },
    {
      name: "Pi Commands (slash commands)",
      tier: "pi-commands",
      commands: [
        { phrase: "new session", action: "/new" },
        { phrase: "compact / summarize", action: "/compact" },
        { phrase: "clear history", action: "/clear" },
        { phrase: "reload", action: "/reload" },
        { phrase: "change model to ...", action: "/model <name>" },
      ],
    },
    {
      name: "Navigation & control",
      tier: "navigation",
      commands: [
        { phrase: "scroll up / scroll down", action: "Scroll output" },
        { phrase: "read again", action: "Repeat last TTS" },
        { phrase: "stop reading", action: "Stop TTS playback" },
        { phrase: "voice mode on/off", action: "Toggle voice mode" },
      ],
    },
  ];

  return groups.filter((_g, i) => {
    // "all" includes everything; otherwise include tiers up to the active one
    if (activeTier === "all") return true;
    return i <= activeIdx;
  });
}

// ─── Provider Descriptions (dynamic based on current selection) ─────────

function describeSTTProvider(providers: ProviderInfo[]): string {
  // Return a summary for the description line
  const available = providers.filter((p) => p.isAvailable).length;
  const total = providers.length;
  return available + " of " + total + " providers ready (use h/l to cycle)";
}

function describeTTSProvider(providers: ProviderInfo[]): string {
  const available = providers.filter((p) => p.isAvailable).length;
  const total = providers.length;
  return available + " of " + total + " providers ready (use h/l to cycle)";
}

// ─── Voice Lists ────────────────────────────────────────────────────────

/** Built-in voice presets for a provider (without the "Custom" sentinel). */
function getVoicePresets(provider: TTSProviderName): string[] {
  switch (provider) {
    case "edge-tts":
      return [
        "en-US-AriaNeural",
        "en-US-GuyNeural",
        "en-US-JennyNeural",
        "en-GB-SoniaNeural",
        "en-AU-NatashaNeural",
      ];
    case "openai":
      return ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];
    case "elevenlabs":
      return ["rachel", "domi", "bella", "antoni", "elli", "josh", "arnold", "adam", "sam"];
    case "cartesia":
      return ["sonic-english", "sonic-multilingual"];
    case "google":
      return ["en-US-Neural2-C", "en-US-Neural2-F", "en-US-Neural2-A", "en-US-Neural2-D"];
    case "azure":
      return ["en-US-JennyNeural", "en-US-GuyNeural", "en-US-AriaNeural"];
    case "deepgram":
      return ["aura-asteria-en", "aura-luna-en", "aura-stella-en", "aura-athena-en"];
    case "piper":
      return ["en_US-lessac-medium", "en_US-amy-medium", "en_US-ryan-medium"];
    case "system":
      return ["default"];
  }
}

/** The cycle list shown in settings: presets followed by "Custom". */
function getVoicesForProvider(provider: TTSProviderName): string[] {
  return [...getVoicePresets(provider), CUSTOM_VOICE];
}

/** Find the preset matching `voice` for a provider (case-insensitive). */
function matchVoicePreset(voice: string, provider: TTSProviderName): string | undefined {
  const trimmed = voice.trim().toLowerCase();
  return getVoicePresets(provider).find((p) => p.toLowerCase() === trimmed);
}

/**
 * Render the voice value for display: the canonical preset name if it matches
 * one, otherwise "Custom (id…)" so the active custom ID is visible at a glance.
 */
function voiceDisplay(voice: string, provider: TTSProviderName): string {
  const preset = matchVoicePreset(voice, provider);
  if (preset) return preset;
  const id = voice.trim();
  if (!id) return CUSTOM_VOICE;
  const shown = id.length > 20 ? id.slice(0, 20) + "…" : id;
  return CUSTOM_VOICE + " (" + shown + ")";
}

// ─── Drawing Helpers ────────────────────────────────────────────────────

function hrLine(width: number): string {
  return "\u2500".repeat(Math.max(0, width));
}

function thinLine(width: number): string {
  return "\u2508".repeat(Math.max(0, width));
}

function padRight(text: string, len: number): string {
  const visible = text.length;
  return visible >= len ? text : text + " ".repeat(len - visible);
}

/**
 * Estimate the number of ANSI escape characters in a string so that
 * padRight can work correctly with styled text.  This is a rough
 * heuristic — it counts bytes in escape sequences.
 */
function ansiOverhead(text: string): number {
  const stripped = text.replace(/\x1b\[[0-9;]*m/g, "");
  return text.length - stripped.length;
}
