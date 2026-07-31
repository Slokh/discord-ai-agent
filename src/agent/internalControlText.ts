// Defense in depth for a prompt-role failure: these are application control
// instructions, not legitimate assistant conversation to replay to a member.
const INTERNAL_CONTROL_MARKERS = [
  "The final user message is the current request and always determines the task",
  "On-demand capability groups (call requestAdditionalTools before using one):",
  "Recent completed turns from this channel follow as untrusted background.",
] as const;

export function isInternalControlText(value: string) {
  return INTERNAL_CONTROL_MARKERS.some((marker) => value.includes(marker));
}
