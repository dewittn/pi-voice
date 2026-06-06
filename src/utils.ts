/**
 * Extract typed/pasted printable text from a raw terminal input chunk.
 *
 * Terminals deliver a paste as a single multi-character chunk — sometimes
 * wrapped in bracketed-paste markers (`\e[200~ … \e[201~`) — so an input
 * handler that only accepts one character at a time silently drops pastes
 * (e.g. a 51-character API key). This normalizes such a chunk:
 *
 *  - bracketed-paste content is unwrapped and kept
 *  - an unbracketed chunk with no ESC byte is treated as typed/pasted text
 *  - a chunk that begins a control sequence (arrow/function keys: `\e[A`…)
 *    is ignored so its bytes never leak in as literal characters
 *
 * Control characters (newlines, tabs, DEL) are stripped; all other printable
 * characters — including non-ASCII — are preserved.
 */
export function extractPastedText(data: string): string {
  // Bracketed paste: collect everything between the start/end markers.
  const bracketed = /\x1b\[200~([\s\S]*?)\x1b\[201~/g;
  let collected = "";
  let sawBracketed = false;
  let match: RegExpExecArray | null;
  while ((match = bracketed.exec(data)) !== null) {
    sawBracketed = true;
    collected += match[1];
  }
  if (sawBracketed) return filterPrintable(collected);

  // Not bracketed: a chunk containing ESC is a control sequence, not text.
  if (data.includes("\x1b")) return "";

  return filterPrintable(data);
}

/** Keep only printable characters (drops control chars and DEL). */
function filterPrintable(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code >= 32 && code !== 127) out += ch;
  }
  return out;
}

/** Redact API keys and tokens from error messages and URLs */
export function redactSecrets(text: string): string {
  return text
    .replace(/([?&])(key|token|api_key|apikey)=[^&\s]+/gi, "$1$2=REDACTED")
    .replace(/(Authorization:\s*)(Token|Bearer)\s+\S+/gi, "$1$2 REDACTED")
    .replace(/(xi-api-key:\s*)\S+/gi, "$1REDACTED")
    .replace(/(Ocp-Apim-Subscription-Key:\s*)\S+/gi, "$1REDACTED")
    .replace(/(X-API-Key:\s*)\S+/gi, "$1REDACTED")
    .replace(/(X-goog-api-key:\s*)\S+/gi, "$1REDACTED");
}
