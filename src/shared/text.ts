// Text helpers shared by server and client.

/** OD-6: maximum message length in UTF-16 code units. */
export const MAX_TEXT_LEN = 4096;

export const PREVIEW_CUT_THRESHOLD = 110;
export const PREVIEW_CUT_LENGTH = 100;

/** True when text is empty after trimming whitespace (BR-SEND-1). */
export function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

/**
 * One-line preview (BR-LIST-7): line breaks become spaces, trimmed, and if longer
 * than 110 characters cut to 100 characters plus an ellipsis.
 */
export function previewText(text: string): string {
  const oneLine = text.replace(/\s*[\r\n]+\s*/g, " ").trim();
  if (oneLine.length > PREVIEW_CUT_THRESHOLD) {
    return oneLine.slice(0, PREVIEW_CUT_LENGTH) + "…";
  }
  return oneLine;
}

/** BR-SEND-2: split into consecutive chunks of at most maxLen code units. */
export function splitText(text: string, maxLen: number = MAX_TEXT_LEN): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + maxLen, text.length);
    // Do not split a surrogate pair.
    if (end < text.length) {
      const code = text.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    }
    chunks.push(text.slice(i, end));
    i = end;
  }
  return chunks;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** UUID v4 that also works outside secure contexts. */
export function uuidV4(): string {
  const c: Crypto | undefined = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
