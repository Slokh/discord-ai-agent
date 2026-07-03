import { truncateForDiscord } from "../util/text.js";

export function cleanResponse(content: string, maxChars: number) {
  return truncateForDiscord(content.trim() || "Done.", maxChars);
}
