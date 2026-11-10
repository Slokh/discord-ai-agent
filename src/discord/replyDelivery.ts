import type { Message } from "discord.js";
import type { AgentFile } from "../tools/types.js";
import type { DiscordResponseFooter, DiscordResponseSink } from "./responseSink.js";

export type DiscordReplyDeliveryResult = {
  reply: Message;
  messageCount: number;
  continuationMessageIds: string[];
};

/** Sends the final reply, with any files and footer, through the turn's response sink. */
export async function deliverDiscordReply(input: {
  responseSink: DiscordResponseSink;
  content: string;
  files?: AgentFile[];
  footer?: DiscordResponseFooter | null;
}): Promise<DiscordReplyDeliveryResult> {
  const result = await input.responseSink.sendFinal({
    content: input.content,
    files: input.files,
    footer: input.footer,
  });
  return {
    reply: result.message,
    messageCount: result.messageCount,
    continuationMessageIds: result.continuationMessageIds,
  };
}
