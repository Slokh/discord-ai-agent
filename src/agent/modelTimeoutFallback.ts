import type { ChatMessage } from "../models/openrouter.js";

export function compactMessagesForModelFallback(messages: ChatMessage[], maxCharacters = 24_000): ChatMessage[] {
  const messageCharacters = (message: ChatMessage) => JSON.stringify(message).length;
  const totalCharacters = messages.reduce((total, message) => total + messageCharacters(message), 0);
  if (totalCharacters <= maxCharacters) return messages;

  const keep = new Set<number>();
  let used = 0;
  const keepIndex = (index: number) => {
    if (keep.has(index)) return;
    keep.add(index);
    used += messageCharacters(messages[index]!);
  };

  if (messages.length > 0) keepIndex(0);
  for (let index = 1; index < messages.length; index += 1) {
    if (messages[index]?.role === "system") keepIndex(index);
  }
  if (messages.length > 1) keepIndex(messages.length - 1);

  for (let index = messages.length - 2; index > 0; index -= 1) {
    if (keep.has(index)) continue;
    const size = messageCharacters(messages[index]!);
    if (used + size > maxCharacters) continue;
    keepIndex(index);
  }
  return messages.filter((_message, index) => keep.has(index));
}
