import type { OpenRouterClient } from "../src/models/openrouter.js";

/** Default rubric for production replays: the new answer must not be worse than the delivered one. */
export const REPLAY_RUBRIC =
  "Grade the CANDIDATE reply to the requester's message. Pass when it answers what was asked at least as well as the REFERENCE reply that was " +
  "actually delivered: correct where the reference is correct, no invented facts, no missing essential information, and no more verbose than " +
  "it needs to be for Discord. Fail when it is wrong, evasive, refuses without reason, asks an unnecessary question, or is clearly worse than the reference.";

export type JudgeVerdict = { pass: boolean; reason: string };

/**
 * Grades one answer against a rubric with a judge model. Code graders run
 * first; the judge exists only for qualities code cannot check.
 */
export async function judgeAnswer(input: {
  openRouter: Pick<OpenRouterClient, "chat">;
  model: string;
  prompt: string;
  answer: string;
  rubric: string;
  referenceAnswer?: string;
}): Promise<JudgeVerdict> {
  const result = await input.openRouter.chat({
    model: input.model,
    reasoningEffort: "low",
    maxTokens: 400,
    messages: [
      {
        role: "system",
        content:
          "You grade replies from a Discord assistant. Follow the rubric exactly. Reply with JSON only: " +
          '{"pass": true|false, "reason": "<one sentence>"}.',
      },
      {
        role: "user",
        content: [
          `RUBRIC:\n${input.rubric}`,
          `REQUESTER MESSAGE:\n${input.prompt}`,
          input.referenceAnswer ? `REFERENCE REPLY:\n${input.referenceAnswer}` : "",
          `CANDIDATE REPLY:\n${input.answer}`,
        ].filter(Boolean).join("\n\n"),
      },
    ],
  });
  return parseVerdict(result.content);
}

export function parseVerdict(text: string): JudgeVerdict {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return { pass: false, reason: "Judge returned no verdict." };
  try {
    const parsed = JSON.parse(match[0]) as { pass?: unknown; reason?: unknown };
    return {
      pass: parsed.pass === true,
      reason: typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : "No reason given.",
    };
  } catch {
    return { pass: false, reason: "Judge returned malformed JSON." };
  }
}
