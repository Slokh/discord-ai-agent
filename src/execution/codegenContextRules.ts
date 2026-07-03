export type CodegenContextRule = {
  focus: string;
  rationale: string;
  likelyMechanisms: string[];
  suggestedFiles: Array<{ path: string; reason: string }>;
  firstInvariant: string;
  suggestedFirstEdit: string;
  avoid: string[];
};

export type CodegenContextAnchorMatch = {
  file: string;
};

const CODEGEN_CONTEXT_RULES: CodegenContextRule[] = [
  {
    focus: "discord_knowledge_lifecycle",
    rationale:
      "The request changes what the bot stores, indexes, embeds, searches, summarizes, or remembers from Discord, so start with the knowledge data lifecycle rather than individual tool names.",
    likelyMechanisms: [
      "Discord crawls and live message events write message/channel/attachment state before retrieval tools can see it.",
      "Embedding workers derive vector rows from stored messages; they should not be the first owner for storage/exclusion behavior.",
      "Permission-aware retrieval, stats, summaries, and attachments share indexed-channel and visibility filters.",
      "Permanent exclusions should be enforced at storage/crawl and retrieval boundaries so future backfills cannot reintroduce data."
    ],
    suggestedFiles: [
      { path: "src/db/repositories.ts", reason: "Owns stored Discord messages, channels, embeddings, retrieval filters, stats, and purge behavior." },
      { path: "src/discord/crawler.ts", reason: "Owns full-server crawl discovery and backfill indexing." },
      { path: "src/discord/messagePersistence.ts", reason: "Owns incremental live message persistence." },
      { path: "src/memory/search.ts", reason: "Owns permission-aware hybrid retrieval orchestration." },
      { path: "src/memory/embedding.ts", reason: "Owns embedding queue/backfill behavior for stored messages." },
      { path: "tests/integration/repository-db.test.ts", reason: "Database coverage for storage, filtering, search, stats, and purge behavior." },
      { path: "tests/unit/crawler.test.ts", reason: "Crawler discovery/indexing coverage." },
      { path: "tests/unit/message-persistence.test.ts", reason: "Incremental persistence coverage." },
      { path: "tests/unit/search.test.ts", reason: "Permission-aware retrieval coverage." }
    ],
    firstInvariant:
      "Discord knowledge changes should be enforced at the durable storage/indexing boundary and again at retrieval, so indexed history, embeddings, stats, summaries, and attachments cannot disagree.",
    suggestedFirstEdit:
      "Patch the storage/retrieval owner first, then add the closest repository/crawler/persistence regression before touching model-facing tool descriptions.",
    avoid: [
      "Do not start in the tool registry just because the task mentions search/stat/summary tool names.",
      "Do not solve durable knowledge changes with prompt-only or model-only behavior."
    ]
  },
  {
    focus: "agent_task_status_lifecycle",
    rationale:
      "The request mentions code updates, coding agents, progress, loading, completion, PRs, or sandbox behavior, so start with the durable agent task lifecycle.",
    likelyMechanisms: [
      "A Discord request can acknowledge immediately with the response sink, then create a lazy status reply only when progress needs to be visible.",
      "Code-update tool calls enqueue an agent task with the current Discord status message as the durable render target.",
      "The task notifier renders queued/running/terminal state back into the original Discord message.",
      "Terminal task rendering must win over stale progress, late callbacks, and notification failures."
    ],
    suggestedFiles: [
      { path: "src/tools/agentTaskTools.ts", reason: "Enqueues code-update tasks and creates the initial user-visible status." },
      { path: "src/discord/responseSink.ts", reason: "Owns Discord acknowledgement, lazy status replies, final replies, files, and loading-reaction cleanup." },
      { path: "src/discord/taskNotifications.ts", reason: "Renders task progress and terminal PR/failure states back to Discord." },
      { path: "src/db/repositories.ts", reason: "Persists task status, render signatures, and terminal task state." },
      { path: "src/jobs/queue.ts", reason: "Starts sandbox work and records task progress." },
      { path: "tests/unit/task-notifications.test.ts", reason: "Focused coverage for task message rendering." },
      { path: "tests/integration/repository-db.test.ts", reason: "Database coverage for terminal state and late progress behavior." }
    ],
    firstInvariant:
      "A code-update request should transition the same Discord status message to a terminal PR/failure/no-change state without leaving stale loading/progress text after completion.",
    suggestedFirstEdit:
      "Add or update a focused task notification or repository test proving terminal code-update state replaces stale progress after earlier render/status problems.",
    avoid: ["Do not search only for the user's exact wording; map product terms like loading/progress/done to task state and Discord message rendering."]
  },
  {
    focus: "discord_response_lifecycle",
    rationale:
      "The request mentions Discord-visible acknowledgement, replies, reactions, status/progress messages, files, or cleanup, so start with the shared response lifecycle.",
    likelyMechanisms: [
      "Discord mentions should acknowledge immediately without forcing a visible status message for every request.",
      "The response sink owns loading reactions, lazy status messages, final replies, file attachments, and cleanup.",
      "Queued worker execution must use the same response lifecycle as inline execution after refetching the source message.",
      "Code-update progress uses the current sink status message as the durable task-notification target."
    ],
    suggestedFiles: [
      { path: "src/discord/responseSink.ts", reason: "Single owner for Discord acknowledgements, status updates, final replies, attachments, and cleanup." },
      { path: "src/discord/client.ts", reason: "Wires Discord mention handling, queued request execution, and tool context status callbacks." },
      { path: "src/tools/agentTaskTools.ts", reason: "Uses status callbacks when model-selected tools need durable progress, especially codegen." },
      { path: "src/discord/taskNotifications.ts", reason: "Edits the durable status message for running and terminal code-update state." },
      { path: "tests/unit/discord-response-sink.test.ts", reason: "Focused coverage for the shared response lifecycle." },
      { path: "tests/unit/discord-client.test.ts", reason: "Discord adapter coverage." },
      { path: "tests/unit/task-notifications.test.ts", reason: "Task progress rendering coverage." }
    ],
    firstInvariant:
      "One Discord prompt should have a single coherent lifecycle: immediate acknowledgement, optional progress/status updates, exactly one final user-visible reply/update, and acknowledgement cleanup.",
    suggestedFirstEdit:
      "Patch the response sink or the client/sink wiring first, then update the nearest focused response-lifecycle test before broad exploration.",
    avoid: [
      "Do not patch separate inline and queued Discord reply paths independently when a shared response sink can own the behavior.",
      "Do not make every prompt create a progress message if a lightweight acknowledgement is enough."
    ]
  },
  {
    focus: "discord_interaction_lifecycle",
    rationale: "The request mentions Discord messages, replies, memory, timeouts, or conversation behavior.",
    likelyMechanisms: [
      "Discord messages enter through the client adapter, are persisted, and are routed through the model/tool loop.",
      "Conversation memory is per Discord channel/thread and final responses are stored back into the session."
    ],
    suggestedFiles: [
      { path: "src/discord/client.ts", reason: "Discord message handling and reply/edit behavior." },
      { path: "src/discord/responseSink.ts", reason: "Discord acknowledgement/status/final-response lifecycle." },
      { path: "src/agent/router.ts", reason: "Agent runtime, model/tool loop, and final response synthesis." },
      { path: "src/discord/messagePersistence.ts", reason: "Message persistence and incremental sync behavior." },
      { path: "tests/unit/discord-client.test.ts", reason: "Discord adapter coverage." },
      { path: "tests/integration/agent.test.ts", reason: "End-to-end agent behavior coverage." }
    ],
    firstInvariant: "Encode the requested Discord-visible behavior as one observable message/reply/session invariant.",
    suggestedFirstEdit: "Start with the closest Discord adapter or agent integration test, then make the minimal implementation change.",
    avoid: ["Do not bypass permission filtering or conversation memory contracts."]
  },
  {
    focus: "model_tool_routing",
    rationale: "The request mentions tools, search, model behavior, prompts, schemas, stats, or routing.",
    likelyMechanisms: [
      "The model chooses from explicit tools registered in the tool registry.",
      "Tool quality should usually improve through descriptions, schemas, result formatting, and retrieval behavior rather than hidden request-specific branches."
    ],
    suggestedFiles: [
      { path: "src/tools/registry.ts", reason: "Tool descriptions and schemas visible to the model." },
      { path: "src/tools/coreTools.ts", reason: "Compatibility facade for local tool implementations." },
      { path: "src/tools/agentTaskTools.ts", reason: "Code-update task tools and deployment/task status behavior." },
      { path: "src/tools/discordHistoryFormatting.ts", reason: "Discord history result shape and retrieval summary formatting." },
      { path: "src/tools/discordStatsFormatting.ts", reason: "Discord stats/topic result shape and grouping behavior." },
      { path: "src/agent/router.ts", reason: "Model/tool execution loop." },
      { path: "tests/unit/tool-registry.test.ts", reason: "Tool schema coverage." },
      { path: "tests/unit/core-tools.test.ts", reason: "Tool behavior coverage." }
    ],
    firstInvariant: "Make the model have a better general-purpose tool affordance for the request class without adding hidden semantic branching.",
    suggestedFirstEdit: "Improve the narrowest tool schema/result/test that would let the model choose and use the right capability.",
    avoid: ["Do not add regex-only request routing when a tool contract can be improved instead."]
  },
  {
    focus: "general_implementation",
    rationale: "No narrower lifecycle matched confidently, so start from the likely adapter/tool/runtime boundary and nearest tests.",
    likelyMechanisms: ["Most user-visible behavior enters through the Discord adapter, model router, tool registry, or focused tool-family modules."],
    suggestedFiles: [
      { path: "src/discord/client.ts", reason: "Discord-facing behavior and request lifecycle." },
      { path: "src/agent/router.ts", reason: "Model-led agent behavior and final response synthesis." },
      { path: "src/tools/coreTools.ts", reason: "Compatibility facade for local tool implementations." },
      { path: "src/tools/README.md", reason: "Tool-family ownership map for the implementation behind the facade." },
      { path: "tests/integration/agent.test.ts", reason: "End-to-end model/tool behavior tests." }
    ],
    firstInvariant: "Turn the requested behavior into one focused observable invariant, implement the smallest code path that satisfies it, then broaden only as needed.",
    suggestedFirstEdit: "Start by adding or updating the closest existing test around the likely entry point before broad repository exploration.",
    avoid: ["Do not start with broad repository-wide exploration when a likely entry point is available."]
  }
];

export function selectCodegenContextRule(taskRequest: string, anchorMatches: CodegenContextAnchorMatch[] = []): CodegenContextRule {
  const text = taskRequest.toLowerCase();
  const anchorFiles = new Set(anchorMatches.map((match) => match.file));
  const hasDiscordClientAnchor = [...anchorFiles].some((file) => file === "src/discord/client.ts" || file.startsWith("src/discord/"));
  const hasTaskLifecycleAnchor = [...anchorFiles].some((file) =>
    ["src/discord/taskNotifications.ts", "src/tools/agentTaskTools.ts", "src/tools/coreTools.ts", "src/jobs/queue.ts", "src/db/repositories.ts"].includes(file)
  );
  if (hasDiscordClientAnchor && !hasTaskLifecycleAnchor && includesAny(text, ["thinking", "reply", "reaction", "message", "discord"])) {
    return codegenContextRule("discord_response_lifecycle");
  }

  const hasCodeUpdateTerm = includesAny(text, [
    "code update",
    "coding agent",
    "codegen",
    "sandbox",
    "pull request",
    " pr",
    "github",
    "update itself",
    "update yourself",
    "self-update",
    "self update",
    "agent task"
  ]);
  const hasStatusTerm = includesAny(text, ["loading", "thinking", "status", "progress", "stuck", "hang", "finish", "done", "complete"]);
  const hasResponseLifecycleTerm = includesAny(text, [
    "reply",
    "replies",
    "reaction",
    "react",
    "loading",
    "thinking",
    "status message",
    "progress message",
    "acknowledge",
    "acknowledgement",
    "attachment",
    "files"
  ]);
  if (hasCodeUpdateTerm || (hasStatusTerm && includesAny(text, ["code", "agent", "bot", "request"]))) return codegenContextRule("agent_task_status_lifecycle");
  if (hasDiscordClientAnchor && hasResponseLifecycleTerm) return codegenContextRule("discord_response_lifecycle");
  if (isDiscordKnowledgeLifecycleRequest(text)) return codegenContextRule("discord_knowledge_lifecycle");
  if (includesAny(text, ["tool", "search", "history", "web", "model", "prompt", "router", "schema", "stats"])) return codegenContextRule("model_tool_routing");
  if (includesAny(text, ["discord", "mention", "reply", "message", "timeout", "content filter", "conversation", "memory"])) {
    return hasResponseLifecycleTerm ? codegenContextRule("discord_response_lifecycle") : codegenContextRule("discord_interaction_lifecycle");
  }
  return codegenContextRule("general_implementation");
}

function isDiscordKnowledgeLifecycleRequest(text: string) {
  const knowledgeTerms = [
    "knowledge",
    "indexed",
    "indexing",
    "indexer",
    "crawler",
    "crawl",
    "backfill",
    "embedder",
    "embedding",
    "embeddings",
    "retrieval",
    "search index",
    "message index",
    "discord history",
    "server history",
    "stored messages",
    "channel id",
    "channel knowledge"
  ];
  const mutationTerms = ["exclude", "excluded", "remove", "purge", "delete", "blocklist", "filter out", "never index", "never store", "never embed", "never return"];
  return includesAny(text, knowledgeTerms) && includesAny(text, mutationTerms);
}

function codegenContextRule(focus: string) {
  const rule = CODEGEN_CONTEXT_RULES.find((candidate) => candidate.focus === focus);
  if (!rule) throw new Error(`Missing codegen context rule: ${focus}`);
  return rule;
}

function includesAny(text: string, needles: string[]) {
  return needles.some((needle) => text.includes(needle));
}
