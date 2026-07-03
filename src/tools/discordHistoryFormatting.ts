import type { SearchResult } from "../db/repositories.js";
import { truncateForDiscord } from "../util/text.js";
import { extractMentionId } from "./toolContext.js";

const MS_PER_DAY = 86_400_000;

export type DiscordSummaryEvidenceCounts = {
  semantic: number;
  keyword: number;
  recent: number;
  representative: number;
};

export function formatDiscordHistorySummaryResult(
  summary: string,
  input: {
    question: string;
    authorIds: string[];
    aboutUserIds: string[];
    channelIds: string[];
    dateFrom?: Date;
    dateTo?: Date;
    retrievalQuery: string;
    counts: DiscordSummaryEvidenceCounts;
    sampleCount: number;
    sampleLimit: number;
    evidenceDates: string;
    evidenceAuthors: string;
  }
) {
  return [
    "Discord history summary:",
    "- Scope: requester-visible indexed Discord messages",
    `- Question: ${input.question}`,
    `- Applied filters: ${formatDiscordHistorySummaryFilters(input)}`,
    `- Retrieval query: ${input.retrievalQuery || "(broad summary)"}`,
    `- Retrieval mix: semantic=${input.counts.semantic}, keyword=${input.counts.keyword}, recent=${input.counts.recent}, representative=${input.counts.representative}`,
    `- Sample count: ${input.sampleCount}/${input.sampleLimit}`,
    `- Evidence dates: ${input.evidenceDates}`,
    `- Evidence authors: ${input.evidenceAuthors}`,
    "- Coverage: representative sample, not exhaustive",
    "",
    "Summary:",
    summary.trim()
  ].join("\n");
}

export function coerceDateStart(value: string | Date | undefined) {
  if (!value) return undefined;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? parseUtcDateStart(value) : undefined;
}

export function coerceDateEnd(value: string | Date | undefined) {
  if (!value) return undefined;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? parseUtcDateEnd(value) : undefined;
}

export function formatHistoryEvidence(input: {
  question: string;
  query: string;
  results: SearchResult[];
  context: string;
  dateFrom?: Date;
  dateTo?: Date;
}) {
  const dateSummary = historyEvidenceDateSummary(input.results);
  const authors = historyEvidenceAuthors(input.results);
  const appliedDateFilter = historyEvidenceAppliedDateFilter(input.dateFrom, input.dateTo);
  return [
    "Discord search evidence:",
    `Question: ${input.question}`,
    `Effective query: ${input.query || "(recent messages)"}`,
    `Result count: ${input.results.length}`,
    `Applied date filter: ${appliedDateFilter}`,
    `Evidence dates: ${dateSummary}`,
    `Evidence authors: ${authors}`,
    "Use links only if helpful or if the user asked for links, sources, receipts, proof, or exact messages. Otherwise do not add citation markers, raw Discord URLs, or a Sources section.",
    "These are historical Discord messages, not necessarily recent/current events. Use the timestamps for grounding, but only show dates when the user asks about timing, links, sources, proof, or exact messages, or when needed to avoid making old evidence sound current.",
    "When naming people from this evidence, use only the exact @handles or IDs shown in the result lines. Do not infer real names, display names, or create @handles from message text.",
    "If the final answer mentions dates or times, use only the exact timestamps shown here. If the results do not support the answer, say that clearly.",
    "",
    input.context
  ].join("\n");
}

export function fallbackDiscordHistorySummary(input: { question: string; samples: SearchResult[]; dateFrom?: Date; dateTo?: Date }) {
  const notable = [...input.samples]
    .sort((left, right) => right.score - left.score || right.createdAt.getTime() - left.createdAt.getTime())
    .slice(0, 10);
  const dateSummary = historyEvidenceDateSummary(input.samples);
  const appliedDateFilter = historyEvidenceAppliedDateFilter(input.dateFrom, input.dateTo);
  return [
    `Representative Discord history for: ${input.question}`,
    `Applied date filter: ${appliedDateFilter}`,
    `Sample dates: ${dateSummary}`,
    "",
    ...notable.map((result) => {
      const author = result.authorUsername ? `@${result.authorUsername}` : result.authorId;
      const content = truncateForDiscord((result.normalizedContent || result.content).replace(/https?:\/\/\S+/g, "[link]"), 220);
      return `- ${author} on ${result.createdAt.toISOString().slice(0, 10)}: "${content}"`;
    })
  ].join("\n");
}

export function historyEvidenceAppliedDateFilter(dateFrom?: Date, dateTo?: Date) {
  const from = dateFrom && !Number.isNaN(dateFrom.getTime()) ? dateFrom.toISOString().slice(0, 10) : null;
  const to = dateTo && !Number.isNaN(dateTo.getTime()) ? dateTo.toISOString().slice(0, 10) : null;
  if (from && to) return `${from} to ${to}`;
  if (from) return `from ${from}`;
  if (to) return `until ${to}`;
  return "none";
}

export function historyEvidenceAuthors(results: SearchResult[]) {
  const authors = uniqueStrings(
    results.map((result) => (result.authorUsername ? `@${result.authorUsername}` : result.authorId)).filter(Boolean)
  );
  return authors.length > 0 ? authors.join(", ") : "none";
}

export function historyEvidenceDateSummary(results: SearchResult[]) {
  if (results.length === 0) return "none";
  const dates = results
    .map((result) => result.createdAt)
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());
  if (dates.length === 0) return "unknown";
  const oldest = dates[0];
  const newest = dates[dates.length - 1];
  const oldestDate = oldest.toISOString().slice(0, 10);
  const newestDate = newest.toISOString().slice(0, 10);
  if (oldestDate === newestDate) return oldestDate;
  const spanDays = Math.max(0, Math.round((newest.getTime() - oldest.getTime()) / MS_PER_DAY));
  return `${oldestDate} to ${newestDate} (${spanDays.toLocaleString("en-US")} days)`;
}

export function noHistoryResultsMessage(crawl: Array<{ status: string; channels: number; messages: number }>) {
  const active = crawl.filter((row) => ["pending", "running", "error"].includes(row.status));
  if (active.length === 0) {
    return "I did not find matching indexed Discord messages that you can access.";
  }

  return [
    "I did not find matching indexed Discord messages that you can access yet.",
    `Crawl status: ${active.map((row) => `${row.status}=${row.channels} channels/${row.messages} messages`).join(", ")}.`
  ].join("\n");
}

export function extractHistorySearchSyntax(message: string) {
  const authorIds: string[] = [];
  const channelIds: string[] = [];
  const authorQueries: string[] = [];
  const channelQueries: string[] = [];
  let dateFrom: Date | undefined;
  let dateTo: Date | undefined;
  let query = message;

  query = query.replace(/\bfrom:(?:"([^"]+)"|'([^']+)'|(<@!?\d+>)|([^\s]+))/gi, (_match, quoted, singleQuoted, mention, bare) => {
    const value = String(quoted ?? singleQuoted ?? mention ?? bare ?? "").trim();
    const id = extractMentionId(value, "user");
    if (id) authorIds.push(id);
    else if (value) authorQueries.push(cleanLookupValue(value));
    return " ";
  });

  query = query.replace(/\bin:(?:"([^"]+)"|'([^']+)'|(<#\d+>)|([^\s]+))/gi, (_match, quoted, singleQuoted, mention, bare) => {
    const value = String(quoted ?? singleQuoted ?? mention ?? bare ?? "").trim();
    const id = extractMentionId(value, "channel");
    if (id) channelIds.push(id);
    else if (value) channelQueries.push(cleanLookupValue(value));
    return " ";
  });

  query = query.replace(/\b(?:after|since):(\d{4}-\d{2}-\d{2})\b/gi, (_match, value) => {
    dateFrom = parseUtcDateStart(String(value));
    return " ";
  });

  query = query.replace(/\b(?:before|until):(\d{4}-\d{2}-\d{2})\b/gi, (_match, value) => {
    dateTo = parseUtcDateEnd(String(value));
    return " ";
  });

  query = query.replace(/\b(?:since|after|from)\s+(\d{4}-\d{2}-\d{2})\b/gi, (_match, value) => {
    dateFrom = parseUtcDateStart(String(value));
    return " ";
  });

  query = query.replace(/\b(?:before|until|to)\s+(\d{4}-\d{2}-\d{2})\b/gi, (_match, value) => {
    dateTo = parseUtcDateEnd(String(value));
    return " ";
  });

  return {
    query: query.replace(/\s+/g, " ").trim(),
    authorIds: uniqueStrings(authorIds),
    channelIds: uniqueStrings(channelIds),
    authorQueries: uniqueStrings(authorQueries),
    channelQueries: uniqueStrings(channelQueries),
    dateFrom,
    dateTo
  };
}

function formatDiscordHistorySummaryFilters(input: {
  authorIds: string[];
  aboutUserIds: string[];
  channelIds: string[];
  dateFrom?: Date;
  dateTo?: Date;
}) {
  const filters = [
    input.authorIds.length ? `authorIds=${input.authorIds.join(",")}` : null,
    input.aboutUserIds.length ? `aboutUserIds=${input.aboutUserIds.join(",")}` : null,
    input.channelIds.length ? `channelIds=${input.channelIds.join(",")}` : null,
    input.dateFrom ? `from=${input.dateFrom.toISOString().slice(0, 10)}` : null,
    input.dateTo ? `through=${input.dateTo.toISOString().slice(0, 10)}` : null
  ].filter((filter): filter is string => Boolean(filter));
  return filters.length ? filters.join("; ") : "none";
}

function parseUtcDateStart(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function parseUtcDateEnd(value: string) {
  return new Date(`${value}T23:59:59.999Z`);
}

function cleanLookupValue(value: string) {
  return value.trim().replace(/^[@#]/, "");
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
