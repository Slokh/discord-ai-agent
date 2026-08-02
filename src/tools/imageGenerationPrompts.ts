export function transparentImageRecoveryPrompt(prompt: string) {
  return [
    "BACKGROUND-REMOVAL RECOVERY PASS.",
    "Preserve only the intended foreground subject, identity, pose, composition, colors, and requested edit from the original request.",
    "Output a transparent PNG containing only that complete foreground subject.",
    "If your renderer cannot emit alpha, use a single pure solid chroma-key green background (#00FF00, RGB 0 255 0) filling every background pixel.",
    "Do not add a gradient, texture, scenery, floor, frame, shadow, glow, reflections, text, or other objects. Keep a clean hard edge between the complete subject and the green background.",
    "Original request:",
    prompt,
  ].join("\n");
}
