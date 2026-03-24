export async function sendZaloMessage(
  botToken: string,
  chatId: string,
  text: string
): Promise<boolean> {
  if (!botToken || !chatId) return false;

  try {
    const res = await fetch(
      `https://bot-api.zaloplatforms.com/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
      }
    );
    return res.ok;
  } catch {
    return false;
  }
}
