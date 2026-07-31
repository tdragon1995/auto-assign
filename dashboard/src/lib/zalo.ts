/** Zalo's sendMessage caps text at 2000 characters. */
export const ZALO_TEXT_LIMIT = 2000;

export type ZaloParseMode = "markdown" | "html";

/** Reduce Zalo markup to readable plain text, for the unformatted retry.
 *  Handles the subset this codebase emits: bold/italic markers and colour tags. */
export function stripFormatting(text: string): string {
  return text
    .replace(/\{\/?[a-z]+\}/gi, "") // {green} … {/green}
    .replace(/\*\*\*(.+?)\*\*\*/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/~~(.+?)~~/g, "$1");
}

export async function sendZaloMessage(
  botToken: string,
  chatId: string,
  text: string,
  parseMode?: ZaloParseMode
): Promise<boolean> {
  if (!botToken || !chatId) return false;

  const url = `https://bot-api.zaloplatforms.com/bot${botToken}/sendMessage`;
  const post = (body: Record<string, unknown>) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  try {
    const res = await post({ chat_id: chatId, text, ...(parseMode ? { parse_mode: parseMode } : {}) });
    if (res.ok) return true;

    // A rejected parse_mode must not cost us the message: resend it unformatted so
    // the content still lands, just plainer. Only retries when formatting was the
    // thing we added, so plain callers keep their existing single-request behaviour.
    // The markup has to come OUT for the retry — without parse_mode the server stops
    // consuming it and the reader would see literal "**" and "{green}".
    if (parseMode) {
      const plain = await post({ chat_id: chatId, text: stripFormatting(text) });
      return plain.ok;
    }
    return false;
  } catch {
    return false;
  }
}
