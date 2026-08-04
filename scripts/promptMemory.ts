import type { DiscordAiAgentRepository } from "../src/db/repositories.js";
import type { AgentResponse } from "../src/tools/types.js";

type LocalPromptMemoryRepository = Pick<
  DiscordAiAgentRepository,
  "appendConversationMessage" | "appendConversationTurn"
>;

type SavedPromptFile = {
  name: string;
  contentType?: string;
  bytes: number;
  path: string;
};

export async function persistLocalPromptTurn(input: {
  repo: LocalPromptMemoryRepository;
  threadKey: string;
  requestId: string;
  userId: string;
  userDisplayName: string;
  botId: string;
  botDisplayName: string;
  prompt: string;
  response: Pick<AgentResponse, "content" | "memoryEvents">;
  savedFiles: SavedPromptFile[];
  channelId: string;
  channelName: string | null;
}) {
  const replyMessageId = `${input.requestId}-reply`;
  await input.repo.appendConversationTurn({
    threadKey: input.threadKey,
    turnId: input.requestId,
    user: {
      discordMessageId: input.requestId,
      authorId: input.userId,
      authorDisplayName: input.userDisplayName,
      content: input.prompt,
      metadata: {
        source: "local_prompt",
        channelId: input.channelId,
        channelName: input.channelName,
      },
    },
    assistant: {
      discordMessageId: replyMessageId,
      authorId: input.botId,
      authorDisplayName: input.botDisplayName,
      content: input.response.content,
      metadata: {
        source: "local_prompt",
        files: input.savedFiles,
      },
    },
  });

  for (const memoryEvent of input.response.memoryEvents ?? []) {
    await input.repo.appendConversationMessage({
      threadKey: input.threadKey,
      role: memoryEvent.role,
      authorId: input.botId,
      authorDisplayName: input.botDisplayName,
      content: memoryEvent.content,
      metadata: {
        ...memoryEvent.metadata,
        source: "local_prompt",
        turnId: input.requestId,
        turnStatus: "completed",
      },
    });
  }
}
