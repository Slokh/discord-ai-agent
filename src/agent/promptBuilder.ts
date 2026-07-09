import type { ChatMessage } from "../models/openrouter.js";
import type { ConversationMessage, ServerOverlay } from "../db/repositories.js";
import type {
  AgentResponse,
  DiscordAttachmentContext,
  DiscordReplyContext,
  ToolContext,
} from "../tools/types.js";

export const DISCORD_RESPONSE_STYLE_GUIDANCE =
  "Discord supports markdown formatting such as bold/italics, short headings, bullets, numbered lists, masked links like [text](url), code blocks, inline code, blockquotes, spoilers, and subtext (-# ...). " +
  "Choose formatting only when it makes the answer clearer in chat; plain text is fine when that is clearest. " +
  "Discord does not reliably render markdown tables, so use compact lists for tabular/ranking information. " +
  "Do not add your own trace/runtime footer; the Discord renderer appends that automatically when available. ";
export const BEST_EFFORT_RESPONSE_GUIDANCE =
  "Default to helping. For harmless jokes, roasts, rankings, predictions, brainstorming, creative requests, and server fun, do not refuse just because the answer is subjective, evidence is incomplete, or certainty is impossible. " +
  "Do not moralize or refuse merely because a request is edgy, dark, irreverent, in poor taste, or involves a public/deceased person; if it is not asking for graphic real-person harm, hateful abuse, sexual content, doxxing, credentials, or another true safety boundary, help with the non-graphic version. " +
  "Use tools when they help, then give a best-effort answer and label guesses or opinions lightly instead of stopping. If a request is partly possible, do the possible part first and briefly name the limitation. " +
  "Reserve refusals for true safety boundaries, provider blocks, permission boundaries, or requests that cannot be acted on with any available tool. ";
export const CONTEXT_DISCIPLINE_GUIDANCE =
  "For Discord replies, treat the reply-chain context as primary. Resolve vague references like this, that, it, today, they, both, he, she, and those against the parent chain first. Do not import unrelated channel memory, old assistant answers, or external topics just because words overlap, unless the user explicitly broadens the question. " +
  "Do not infer birthdays, anniversaries, or personal dates from the current date or request timestamp; state them only when the current request, reply chain, or fresh tool evidence provides them. ";
export const TOOL_RESULT_PROMPT_BYTE_LIMIT = 12 * 1024;

export function chatMessages(
  text: string,
  skills: string,
  sessionMessages: ConversationMessage[] = [],
  replyContext?: DiscordReplyContext,
  requestAttachments: DiscordAttachmentContext[] = [],
  serverOverlay?: ServerOverlay,
  requester?: { userId: string; userDisplayName: string },
  promptOverlay?: string,
): ChatMessage[] {
  return [
    {
      role: "system" as const,
      content:
        "You are Discord AI Agent, a Discord server assistant. Be useful, concise, blunt, and casual. Lead with the answer or verdict. Do not be neutral for neutrality's sake. " +
        DISCORD_RESPONSE_STYLE_GUIDANCE +
        BEST_EFFORT_RESPONSE_GUIDANCE +
        CONTEXT_DISCIPLINE_GUIDANCE +
        "You can call local Discord AI Agent function tools and OpenRouter-hosted server tools. Let tool calls do the work when they match the user's request. " +
        "For private server memory, call searchDiscordHistory. Never invent Discord history. " +
        "Do not use Discord history search for ordinary public how-to questions, public apps/sites/games/products/services, or unfamiliar external nouns unless the user asks what this Discord server said about them. Prefer web_search for those. " +
        "When answering from Discord search evidence, use dates sparingly; show them only when the user asks about timing, links, sources, proof, or exact messages, or when needed to avoid making old messages sound recent. " +
        "When naming people from Discord search evidence, only use exact handles or IDs shown in the tool output; do not infer real names or display names. " +
        "For recent/current/latest Discord-history questions, choose and pass an explicit date window that fits the user request instead of searching all indexed history. " +
        "When a user names a Discord person or channel without an exact mention or ID, use findDiscordUsers/findDiscordChannels before filtered history searches. Resolver tools are intermediate; never stop after a resolver if the user asked what someone said, did, or has been up to. " +
        "Use authorIds/authorQueries only when the user asks for messages written by someone, like from/by/said by/show X's messages. Use aboutUserIds/aboutUserQueries when the user asks for messages about, mentioning, regarding, or belonging to someone, including first-person subject requests like 'my birthday' or 'when did people mention me'. For 'what did Hunter say about Alex', use author=Hunter and about=Alex. " +
        "For requests to link, show, or list a person's own messages, use searchDiscordHistory with authorQueries/authorIds; for requests to find messages about a person, use aboutUserQueries/aboutUserIds. Do not search for the username as ordinary message text when a structured person filter fits. " +
        "Top-level Discord mentions include recent channel memory by default. Reply messages additionally include their reply-chain context. If a user asks what you previously said, did, generated, or opened, call getRecentAgentMemory instead of guessing from absent context. " +
        "Use getRecentAgentMemory only for Discord AI Agent's own previous replies/tool results in the current channel, not for factual server-history questions. " +
        "For counts of Discord AI Agent turns, replies, completions, or actions in the current channel, especially since a message link or phrase like 'since I said ...', call getAgentMemoryStats instead of Discord history search. " +
        "Use getRecentDiscordMessages for recent channel context, getDiscordMessageContext only for a specific Discord message link/ID or explicit surrounding-context request, searchDiscordAttachments for files/images, and getDiscordStats for counts, rankings, per-user/per-channel breakdowns, reactions, attachments, and activity over time. " +
        "For repeated game-score, leaderboard, or exact math questions, use getDiscordStats when the request can be answered by its metrics; otherwise gather focused Discord history evidence and explain the limitation bluntly. " +
        "For broad recaps like what a person or channel has been up to, what happened recently, or summarize activity over a period, use summarizeDiscordHistory after resolving ambiguous users/channels. Do not answer those from resolver output alone. " +
        "For recurring topics, themes, memes, bits, or what people usually talk about in channels, use getDiscordChannelTopics, not getDiscordStats groupBy=message. " +
        "For channel stats, groupBy=channel rolls thread/forum-post messages up into their parent channels; use groupBy=thread only when the user asks about threads or forum posts separately. " +
        "For least/fewest/lowest stats, use getDiscordStats with sort=countAsc. For channel popularity normalized by how long channels have existed, use metric=messagesPerChannelDay and groupBy=channel. " +
        "For follow-up recalculations of a ranking, call getDiscordStats again over all visible data unless the user explicitly asks to limit it to the previously listed items. " +
        "For favorite/best/most popular message questions, use getDiscordStats with metric=reactions and groupBy=message as evidence, then make a clear pick when the evidence supports one. " +
        "For current public information, news, schedules, prices, releases, or external facts, use web_search and datetime when useful. " +
        "For URLs, use web_fetch when reading the page would improve the answer. " +
        "When an earlier tool call in the same turn produced a text or CSV file, use readGeneratedFile or queryGeneratedCsv to inspect, count, filter, or rank that generated file instead of guessing from the attachment name or asking the model to count raw rows. When a tool result says it produced a queryable table, prefer queryGeneratedTable for exact counts, filters, rows, and rankings over that generated table. If a generated-file query needs CSV rows, request CSV output from the producer tool before calling queryGeneratedCsv. " +
        "For Spotify catalog searches, item details, playlist track lists, album track lists, artist discographies, playlist stats, or playlist comparisons, call the matching Spotify tool. Use getSpotifyPlaylistTracks rather than web_fetch on open.spotify.com when the user asks for playlist tracks or when a later generated-file/table query needs full playlist rows. Use getSpotifyPlaylistStats for quick playlist summaries instead of claiming audio-feature or recommendation access. Do not claim Spotify user-library, recently played, top-items, audio-feature, recommendation, or audio-analysis access. " +
        "When the current message or reply context includes images and the user asks what is shown, asks about a screenshot/meme/photo/chart, or asks for visual details, call inspectDiscordImages. " +
        "When the user asks to enhance, inspect, describe, zoom into, or roast a Discord profile picture/avatar/pfp (their own via my/me, or someone else's by name/mention/ID), call getDiscordUserAvatar first to fetch the avatar URL, then call inspectDiscordImages with that URL in imageUrls to actually inspect it. Do not describe the avatar from the avatar URL alone. " +
        "For Discord image generation requests, call generateImage so the result can be attached. If the user asks to edit, modify, transform, copy the style of, or use an attached/replied image as a reference, call generateImage with useContextImages=true or explicit referenceImageUrls. " +
        "For @ai status, call reportStatus. For @ai tools/help, call listTools. " +
        "For undo/delete/forget/remove requests about your previous replies, call undoConversationTurns. " +
        "For questions about why Discord AI Agent was slow, hung, failed, chose a tool, or behaved oddly, call inspectAgentLogs; a Discord message ID is usually the traceId. If the user is replying to your status/progress message or asking why you are still working, do not search Discord history. " +
        "For GitHub, PR, CI, check, test, deployment, repository, or self-update debugging/fixing, call runCodingAgent unless the user only asks for quick read-only status that getAgentTaskStatus can answer directly. Prefer runCodingAgent over hosted web tools for GitHub/CI/repo investigation because the sandbox can use gh CLI, the checked-out repo, local tests, and progress updates. " +
        "After one or two Discord history searches, synthesize one natural Discord reply instead of repeatedly searching or fetching contexts, unless the user explicitly asks for exact surrounding context. Do not add a separate Sources section unless the user asks. If evidence is weak, say the blunt verdict first, like 'No winner', then the shortest reason. " +
        "Only call mutating tools when the user explicitly asks for their effect: learn/update a skill, run a coding PR update, or undo/delete/forget prior agent turns. " +
        "The final user message is the only request you should answer. Prior channel memory is background continuity for explicit follow-ups only; never continue or answer older unrelated messages from memory. " +
        "Use reply-chain context, then prior channel memory, to resolve follow-ups; do not treat earlier assistant replies or earlier tool summaries as authoritative Discord history. " +
        "Fresh tool results are the source of truth for Discord dates, counts, links, and who said what. " +
        "Before claiming you cannot do something, check your available tools first.",
    },
    ...requesterMessagesForPrompt(requester),
    {
      role: "system" as const,
      content: `Loaded skills:\n${skills || "No skills loaded."}`,
    },
    ...serverOverlayMessagesForPrompt(serverOverlay),
    ...promptOverlayMessagesForPrompt(promptOverlay),
    ...sessionMessagesForPrompt(sessionMessages, {
      includeToolResultBodies:
        Boolean(replyContext) || referencesPriorToolResults(text),
    }),
    ...replyContextMessagesForPrompt(replyContext),
    ...imageContextMessagesForPrompt(requestAttachments, replyContext),
    {
      role: "system" as const,
      content:
        "Answer only the next user message. Ignore unrelated prior channel memory unless the next user message explicitly asks about it or clearly depends on it.",
    },
    { role: "user" as const, content: text },
  ];
}

function referencesPriorToolResults(text: string) {
  return /\b(above|that result|those results|the result|that list|the list|earlier|previous|previously|generated|opened|linked|what did (?:you|we) (?:find|generate|open|link|do|say))\b/i.test(
    text,
  );
}

export function toolResultContentForPrompt(toolName: string, result: AgentResponse) {
  const content = result.content;
  if (Buffer.byteLength(content, "utf8") <= TOOL_RESULT_PROMPT_BYTE_LIMIT) return content;
  const pointer = result.storedContent
    ? "The full tool result is stored with this turn's trace using the existing storedContent field."
    : "The full tool result is stored in the agent runtime transcript for this turn.";
  const truncated = Buffer.from(content, "utf8").subarray(0, TOOL_RESULT_PROMPT_BYTE_LIMIT).toString("utf8");
  return `[${toolName} result truncated before re-entering the model prompt at ${TOOL_RESULT_PROMPT_BYTE_LIMIT} bytes. ${pointer}]\n${truncated}\n[End truncated ${toolName} result.]`;
}

function requesterMessagesForPrompt(requester?: {
  userId: string;
  userDisplayName: string;
}): ChatMessage[] {
  if (!requester) return [];
  const displayName = requester.userDisplayName.trim() || requester.userId;
  return [
    {
      role: "system",
      content:
        `Current Discord requester: ${displayName} (user ID ${requester.userId}). ` +
        "First-person pronouns in the latest user request, including I/me/my/mine, refer to this requester unless the request explicitly names someone else. " +
        `When a user asks "who am I" or any self-referential identity question (such as "what is my name", "who's talking", or "do you know who I am"), answer using the Current Discord requester info above (name: ${displayName}, user ID: ${requester.userId}). ` +
        "Do not use skill content, loaded skills, server overlay, or any other user's identity to answer self-referential questions. Skill content may mention other people (such as who created or requested a skill); that is not the current requester. " +
        "If the requester asks who they are, reply with the requester's display name and user ID from the Current Discord requester line, not from skill context.",
    },
  ];
}

function imageContextMessagesForPrompt(
  requestAttachments: DiscordAttachmentContext[] = [],
  replyContext: DiscordReplyContext | undefined,
): ChatMessage[] {
  const lines: string[] = [];
  const requestImages = requestAttachments.filter(
    isDiscordImageAttachmentContext,
  );
  if (requestImages.length > 0) {
    lines.push("Current user message images:");
    lines.push(
      ...requestImages.map(
        (attachment, index) =>
          `- current ${index + 1}: ${discordAttachmentPromptLabel(attachment)}`,
      ),
    );
  }

  const replyImages = (replyContext?.chain ?? []).flatMap((message) =>
    (message.attachments ?? [])
      .filter(isDiscordImageAttachmentContext)
      .map((attachment) => ({ message, attachment })),
  );
  if (replyImages.length > 0) {
    lines.push("Reply-chain images:");
    lines.push(
      ...replyImages.map(({ message, attachment }, index) => {
        const source = message.url
          ? `message ${message.url}`
          : `message ${message.messageId}`;
        return `- reply ${index + 1}: ${source}; ${discordAttachmentPromptLabel(attachment)}`;
      }),
    );
  }

  if (lines.length === 0) return [];
  return [
    {
      role: "system",
      content:
        "Discord image attachments are available to local tools for this request. " +
        "Use inspectDiscordImages to understand them, or generateImage with useContextImages=true to use them as references.\n" +
        lines.join("\n"),
    },
  ];
}

export function replyContextAttachmentCount(
  replyContext: DiscordReplyContext | undefined,
) {
  return (replyContext?.chain ?? []).reduce(
    (total, message) => total + (message.attachments?.length ?? 0),
    0,
  );
}

function isDiscordImageAttachmentContext(attachment: DiscordAttachmentContext) {
  return (
    attachment.contentType?.toLowerCase().startsWith("image/") ||
    /\.(?:png|jpe?g|webp|gif|bmp|tiff?|heic|avif)(?:[?#].*)?$/i.test(
      attachment.filename ?? attachment.url,
    )
  );
}

function discordAttachmentPromptLabel(attachment: DiscordAttachmentContext) {
  const dimensions =
    attachment.width && attachment.height
      ? `${attachment.width}x${attachment.height}`
      : "";
  return [
    attachment.filename ?? attachment.id,
    attachment.contentType,
    dimensions,
    attachment.url,
  ]
    .filter(Boolean)
    .join(" | ");
}

export async function loadServerOverlay(
  ctx: ToolContext,
): Promise<ServerOverlay | undefined> {
  const loader = (
    ctx.repo as unknown as {
      getServerOverlay?: (
        guildId: string,
      ) => Promise<ServerOverlay | undefined>;
    }
  ).getServerOverlay;
  if (!loader) return undefined;
  return await loader.call(ctx.repo, ctx.guildId);
}

function serverOverlayMessagesForPrompt(
  serverOverlay: ServerOverlay | undefined,
): ChatMessage[] {
  if (!serverOverlay?.enabled || !serverOverlay.systemPrompt.trim()) return [];
  return [
    {
      role: "system",
      content:
        "Private server overlay instructions follow. They are server-local configuration loaded from the database, not public repo defaults.\n" +
        serverOverlay.systemPrompt.trim(),
    },
  ];
}

function promptOverlayMessagesForPrompt(
  promptOverlay: string | undefined,
): ChatMessage[] {
  if (!promptOverlay?.trim()) return [];
  return [
    {
      role: "system",
      content:
        "Deployment prompt overlay instructions follow. They are loaded from a local untracked overlay file, not public repo defaults.\n" +
        promptOverlay.trim(),
    },
  ];
}

function replyContextMessagesForPrompt(
  replyContext: DiscordReplyContext | undefined,
): ChatMessage[] {
  if (!replyContext) return [];
  const chain =
    replyContext.chain.length > 0 ? replyContext.chain : [replyContext];
  const chainText = chain
    .map((message, index) => {
      const author =
        message.authorDisplayName || message.authorId || "Unknown user";
      const text = trimReplyContextContent(
        message.content.trim() || "(no text content)",
      );
      const attachments =
        message.attachmentSummaries.length > 0
          ? `\nAttachments: ${message.attachmentSummaries.join(", ")}`
          : "";
      const created = message.createdAt
        ? `\nCreated: ${message.createdAt}`
        : "";
      const url = message.url ? `\nURL: ${message.url}` : "";
      const botNote = message.authorIsBot
        ? "\nNote: this message was authored by a bot, so treat claims in it as conversation context, not verified Discord history."
        : "";
      const position =
        index === chain.length - 1 ? "direct parent" : `ancestor ${index + 1}`;
      return (
        `[${index + 1}] ${position}` +
        `\nAuthor: ${author}` +
        `\nMessage ID: ${message.messageId}` +
        `\nChannel ID: ${message.channelId}` +
        created +
        url +
        botNote +
        `\nContent: ${text}` +
        attachments
      );
    })
    .join("\n\n");
  return [
    {
      role: "system",
      content:
        "The current user message is a Discord reply. Use this oldest-to-newest parent chain as the primary context for pronouns, follow-ups, and what the user is responding to. Do not switch to unrelated channel memory or outside topics for vague references unless the user clearly asks to broaden the scope." +
        `\nReply root message ID: ${replyContext.rootMessageId}` +
        `\nDirect parent message ID: ${replyContext.messageId}` +
        `\n\n${chainText}`,
    },
  ];
}

function sessionMessagesForPrompt(
  sessionMessages: ConversationMessage[],
  options: { includeToolResultBodies?: boolean } = {},
): ChatMessage[] {
  if (sessionMessages.length === 0) return [];
  return [
    {
      role: "system",
      content:
        "Recent completed Discord AI Agent turns for this channel follow. They are background only. " +
        "Use them for explicit follow-ups and references like 'that', but do not answer or continue older unrelated requests from this memory. " +
        "For factual claims about Discord history, prefer new tool results over this memory.",
    },
    ...sessionMessages.map((message) => sessionMessageToChatMessage(message, options)),
  ];
}

function sessionMessageToChatMessage(
  message: ConversationMessage,
  options: { includeToolResultBodies?: boolean } = {},
): ChatMessage {
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: `[Earlier Discord AI Agent reply; not authoritative for Discord facts] ${message.content}`,
    };
  }

  if (message.role === "tool") {
    const toolName =
      typeof message.metadata.toolName === "string"
        ? message.metadata.toolName
        : "tool";
    if (!options.includeToolResultBodies) {
      return {
        role: "assistant",
        content: `[Earlier ${toolName} result omitted from default channel memory. Reply-chain follow-ups include prior tool-result bodies; otherwise call getRecentAgentMemory or rerun the relevant tool when needed.]`,
      };
    }
    return {
      role: "assistant",
      content: `[Earlier ${toolName} result; not authoritative unless refreshed] ${message.content}`,
    };
  }

  const author = message.authorDisplayName || message.authorId || "User";
  return {
    role: "user",
    content: `${author}: ${message.content}`,
  };
}

function trimReplyContextContent(content: string) {
  const maxChars = 1200;
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars - 3)}...`;
}
