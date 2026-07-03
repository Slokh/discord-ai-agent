import type { DiscordChannelTopicCandidate, DiscordStats, DiscordStatsSort } from "../db/repositories.js";
import { truncateForDiscord } from "../util/text.js";

type ChannelTopicCluster = {
  size: number;
  examples: DiscordChannelTopicCandidate[];
};

type DiscordStatsFormatOptions = {
  authorIds: string[];
  channelIds: string[];
  dateFrom?: Date;
  dateTo?: Date;
  query?: string;
  attachmentContentType?: string;
  includeBots: boolean;
  sort?: DiscordStatsSort;
  limit: number;
};

export function formatChannelTopicEvidence(candidates: DiscordChannelTopicCandidate[], topicsPerChannel: number) {
  const groups = [...groupTopicCandidates(candidates).values()];
  if (groups.length === 0) return "No topic candidates.";
  return [
    "Discord channel topic evidence:",
    ...groups.map((group) => {
      const first = group[0];
      const channel = first.channelName ? `#${first.channelName}` : first.channelId;
      const embeddedCount = group.filter((candidate) => candidate.embedding).length;
      const clusters = topicClustersForChannel(group, topicsPerChannel);
      const clusterLines = clusters.flatMap((cluster, index) => [
        `  Cluster ${index + 1}: ${cluster.size} sampled messages`,
        ...cluster.examples.map((example) => `  - ${topicSnippet(example.normalizedContent)}`)
      ]);
      return [
        `${channel} (${first.channelMessageCount.toLocaleString("en-US")} indexed messages; ${group.length} sampled; ${embeddedCount} embedded)`,
        ...clusterLines
      ].join("\n");
    })
  ].join("\n\n");
}

export function formatChannelTopicsResult(
  summary: string,
  input: {
    channelIds: string[];
    dateFrom?: Date;
    dateTo?: Date;
    channelLimit: number;
    topicsPerChannel: number;
    samplesPerChannel: number;
    minChannelMessages: number;
    minMessageChars: number;
    includeBots: boolean;
    candidates: DiscordChannelTopicCandidate[];
  }
) {
  const channelCount = groupTopicCandidates(input.candidates).size;
  const embeddedCount = input.candidates.filter((candidate) => candidate.embedding).length;
  return [
    "Discord channel topics summary:",
    "- Scope: requester-visible indexed Discord messages",
    `- Applied filters: ${formatChannelTopicFilters(input)}`,
    `- Sampling: ${input.candidates.length} candidate messages across ${channelCount} channels (${embeddedCount} embedded)`,
    `- Limits: channelLimit=${input.channelLimit}; topicsPerChannel=${input.topicsPerChannel}; samplesPerChannel=${input.samplesPerChannel}; minChannelMessages=${input.minChannelMessages}; minMessageChars=${input.minMessageChars}`,
    "- Coverage: directional semantic sample, not an exhaustive exact phrase count",
    "",
    "Summary:",
    summary.trim()
  ].join("\n");
}

export function groupTopicCandidates(candidates: DiscordChannelTopicCandidate[]) {
  const groups = new Map<string, DiscordChannelTopicCandidate[]>();
  for (const candidate of candidates) {
    const existing = groups.get(candidate.channelId);
    if (existing) existing.push(candidate);
    else groups.set(candidate.channelId, [candidate]);
  }
  return groups;
}

export function formatDiscordStats(stats: DiscordStats, options: DiscordStatsFormatOptions) {
  const metric = discordStatsMetricLabel(stats.metric);
  const groupedBy = discordStatsGroupByLabel(stats.groupBy);
  const lines = [
    "Discord indexed stats:",
    "- Scope: requester-visible indexed Discord messages",
    `- Applied filters: ${formatDiscordStatsFilters(options)}`,
    `- Row limit: ${options.limit}`,
    `- Metric: ${metric}`,
    `- Grouped by: ${groupedBy}`,
    `- Messages: ${stats.totalMessages}`
  ];
  if (stats.groupBy === "overall" || stats.metric === "attachments") {
    lines.push(`- Attachments: ${stats.totalAttachments}`);
  }
  if (stats.groupBy === "overall" || stats.metric === "reactions") {
    lines.push(`- Reactions: ${stats.totalReactions}`);
  }
  lines.push(`- Users: ${stats.userCount}`, `- Channels: ${stats.channelCount}`, `- Active days: ${stats.activeDays}`);

  if (stats.groupBy !== "overall") {
    lines.push(
      "Results:",
      ...(stats.rows.length
        ? stats.rows.map((row, index) => `  ${index + 1}. ${formatDiscordStatsRowLabel(row)}: ${formatDiscordStatsRowValue(stats, row)}`)
        : ["  none"])
    );
    return lines.join("\n");
  }

  lines.push(
    "- Top users:",
    ...(stats.topUsers.length
      ? stats.topUsers.map((user, index) => `  ${index + 1}. ${user.authorUsername ? `@${user.authorUsername}` : user.authorId}: ${user.messageCount}`)
      : ["  none"]),
    "- Top channels:",
    ...(stats.topChannels.length
      ? stats.topChannels.map((channel, index) => `  ${index + 1}. ${channel.channelName ? `#${channel.channelName}` : channel.channelId}: ${channel.messageCount}`)
      : ["  none"])
  );
  return lines.join("\n");
}

export function discordStatsGroupBy(value: string | undefined): DiscordStats["groupBy"] {
  const allowed: DiscordStats["groupBy"][] = [
    "overall",
    "user",
    "channel",
    "thread",
    "message",
    "day",
    "week",
    "month",
    "year",
    "hourOfDay",
    "dayOfWeek"
  ];
  return allowed.includes(value as DiscordStats["groupBy"]) ? (value as DiscordStats["groupBy"]) : "overall";
}

export function discordStatsMetric(value: string | undefined): DiscordStats["metric"] {
  const normalized = value?.trim();
  const aliases: Record<string, DiscordStats["metric"]> = {
    messagesPerDay: "messagesPerChannelDay",
    messagesPerCreatedDay: "messagesPerChannelDay",
    messagesPerCreationDay: "messagesPerChannelDay",
    messagesPerExistingDay: "messagesPerChannelDay"
  };
  if (normalized && aliases[normalized]) return aliases[normalized];
  const allowed: DiscordStats["metric"][] = [
    "messages",
    "attachments",
    "reactions",
    "uniqueActiveDays",
    "messagesPerActiveDay",
    "messagesPerChannelDay"
  ];
  return allowed.includes(normalized as DiscordStats["metric"]) ? (normalized as DiscordStats["metric"]) : "messages";
}

export function discordStatsSort(value: string | undefined) {
  if (value === "valueAsc") return "countAsc";
  if (value === "valueDesc") return "countDesc";
  const allowed = ["countDesc", "countAsc", "dateAsc", "dateDesc", "labelAsc"];
  return allowed.includes(value ?? "") ? (value as "countDesc" | "countAsc" | "dateAsc" | "dateDesc" | "labelAsc") : undefined;
}

function formatChannelTopicFilters(input: {
  channelIds: string[];
  dateFrom?: Date;
  dateTo?: Date;
  includeBots: boolean;
}) {
  const filters = [
    input.channelIds.length ? `channelIds=${input.channelIds.join(",")}` : null,
    input.dateFrom ? `from=${input.dateFrom.toISOString().slice(0, 10)}` : null,
    input.dateTo ? `through=${input.dateTo.toISOString().slice(0, 10)}` : null,
    input.includeBots ? "includeBots=true" : null
  ].filter((filter): filter is string => Boolean(filter));
  return filters.length ? filters.join("; ") : "none";
}

function topicClustersForChannel(candidates: DiscordChannelTopicCandidate[], topicsPerChannel: number): ChannelTopicCluster[] {
  const embedded = candidates
    .map((candidate) => ({ candidate, vector: normalizeVector(candidate.embedding ?? []) }))
    .filter((item): item is { candidate: DiscordChannelTopicCandidate; vector: number[] } => item.vector.length > 0);
  if (embedded.length < Math.max(6, topicsPerChannel * 2)) {
    return [
      {
        size: candidates.length,
        examples: candidates.slice(0, Math.min(18, candidates.length))
      }
    ];
  }

  const k = Math.min(topicsPerChannel, embedded.length);
  let centroids = Array.from({ length: k }, (_, index) => {
    const source = embedded[Math.floor((index * embedded.length) / k)];
    return [...source.vector];
  });
  let assignments = new Array<number>(embedded.length).fill(0);

  for (let iteration = 0; iteration < 8; iteration += 1) {
    assignments = embedded.map((item) => nearestCentroid(item.vector, centroids));
    centroids = centroids.map((centroid, centroidIndex) => {
      const members = embedded.filter((_, itemIndex) => assignments[itemIndex] === centroidIndex);
      if (members.length === 0) return centroid;
      const mean = new Array<number>(centroid.length).fill(0);
      for (const member of members) {
        for (let dim = 0; dim < mean.length; dim += 1) {
          mean[dim] += member.vector[dim] ?? 0;
        }
      }
      return normalizeVector(mean.map((value) => value / members.length));
    });
  }

  return centroids
    .map((centroid, centroidIndex) => {
      const members = embedded.filter((_, itemIndex) => assignments[itemIndex] === centroidIndex);
      const examples = members
        .map((member) => ({ candidate: member.candidate, score: dotProduct(member.vector, centroid) }))
        .sort((a, b) => b.score - a.score || b.candidate.createdAt.getTime() - a.candidate.createdAt.getTime())
        .slice(0, 5)
        .map((member) => member.candidate);
      return { size: members.length, examples };
    })
    .filter((cluster) => cluster.examples.length > 0)
    .sort((a, b) => b.size - a.size)
    .slice(0, topicsPerChannel);
}

function nearestCentroid(vector: number[], centroids: number[][]) {
  let bestIndex = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const [index, centroid] of centroids.entries()) {
    const score = dotProduct(vector, centroid);
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  }
  return bestIndex;
}

function normalizeVector(vector: number[]) {
  if (vector.length === 0) return [];
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm === 0) return [];
  return vector.map((value) => value / norm);
}

function dotProduct(a: number[], b: number[]) {
  const length = Math.min(a.length, b.length);
  let sum = 0;
  for (let index = 0; index < length; index += 1) {
    sum += (a[index] ?? 0) * (b[index] ?? 0);
  }
  return sum;
}

function topicSnippet(content: string) {
  return truncateForDiscord(content.replace(/https?:\/\/\S+/gi, "[link]").replace(/\s+/g, " ").trim(), 180);
}

function formatDiscordStatsFilters(options: DiscordStatsFormatOptions) {
  const filters = [
    options.authorIds.length ? `authorIds=${options.authorIds.join(",")}` : null,
    options.channelIds.length ? `channelIds=${options.channelIds.join(",")}` : null,
    options.dateFrom ? `from=${options.dateFrom.toISOString().slice(0, 10)}` : null,
    options.dateTo ? `through=${options.dateTo.toISOString().slice(0, 10)}` : null,
    options.query?.trim() ? `query="${truncateForDiscord(options.query.trim(), 120)}"` : null,
    options.attachmentContentType?.trim() ? `attachmentContentType=${options.attachmentContentType.trim()}` : null,
    options.includeBots ? "includeBots=true" : null,
    options.sort ? `sort=${options.sort}` : null
  ].filter((filter): filter is string => Boolean(filter));
  return filters.length ? filters.join("; ") : "none";
}

function formatDiscordStatsRowLabel(row: DiscordStats["rows"][number]) {
  if (row.messageId) {
    const author = row.authorUsername ? `@${row.authorUsername}` : row.authorId ?? "unknown";
    const channel = row.channelName ? `#${row.channelName}` : row.channelId ?? "unknown";
    const timestamp = row.periodStart ? ` at ${row.periodStart.toISOString()}` : "";
    const snippet = row.label ? `: "${truncateForDiscord(row.label, 120)}"` : "";
    return `${author} in ${channel}${timestamp}${snippet}`;
  }
  if (row.channelName) return `#${row.channelName}`;
  if (row.authorUsername) return `@${row.authorUsername}`;
  return row.label;
}

function discordStatsMetricLabel(metric: DiscordStats["metric"]) {
  if (metric === "attachments") return "attachments";
  if (metric === "reactions") return "reactions";
  if (metric === "uniqueActiveDays") return "unique active days";
  if (metric === "messagesPerActiveDay") return "messages per active day";
  if (metric === "messagesPerChannelDay") return "messages per channel day";
  return "messages";
}

function discordStatsGroupByLabel(groupBy: DiscordStats["groupBy"]) {
  if (groupBy === "hourOfDay") return "hour of day";
  if (groupBy === "dayOfWeek") return "day of week";
  if (groupBy === "thread") return "thread/message location";
  return groupBy;
}

function formatDiscordStatsRowValue(stats: DiscordStats, row: DiscordStats["rows"][number]) {
  if (stats.metric === "messagesPerActiveDay") {
    const activeDays = row.activeDays || 1;
    return `${formatStatNumber(row.value)} messages/active day (${formatStatNumber(row.messageCount)} messages over ${formatStatNumber(activeDays)} active days)`;
  }
  if (stats.metric === "messagesPerChannelDay") {
    const channelAgeDays = row.channelAgeDays ?? 1;
    const created = row.channelCreatedAt ? ` since ${row.channelCreatedAt.toISOString().slice(0, 10)}` : "";
    return `${formatStatNumber(row.value)} messages/channel day (${formatStatNumber(row.messageCount)} messages over ${formatStatNumber(channelAgeDays)} days${created})`;
  }
  return formatStatNumber(row.value);
}

function formatStatNumber(value: number) {
  return value.toLocaleString("en-US", {
    maximumFractionDigits: Number.isInteger(value) ? 0 : 4
  });
}
