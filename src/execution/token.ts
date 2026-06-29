import { createHmac, timingSafeEqual } from "node:crypto";

export function taskBearerToken(input: { taskId: string; secret: string }) {
  return createHmac("sha256", input.secret).update(input.taskId).digest("hex");
}

export function verifyTaskBearerToken(input: { taskId: string; secret: string; token: string | undefined }) {
  if (!input.token) return false;
  const expected = Buffer.from(taskBearerToken(input), "utf8");
  const actual = Buffer.from(input.token, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
