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

export function imageSafetyFallbackPrompt(prompt: string) {
  return [
    "Create a clearly stylized, non-photorealistic editorial illustration that preserves only the benign composition, setting, clothing, mood, and harmless action from the request below.",
    "Do not present the result as a real photograph, documentary evidence, endorsement, quotation, or record of a real event.",
    "Do not add sexual content, graphic violence, hateful abuse, wrongdoing instructions, or political persuasion.",
    "If a real person is named, depict them respectfully in a harmless fictional scene without adding claims or actions that were not requested.",
    "Original request:",
    prompt,
  ].join("\n");
}

export function imageRequestRecoveryPrompt(prompt: string) {
  return [
    "REQUEST-COMPATIBILITY RECOVERY PASS.",
    "Create one safe image that preserves the core subject, composition, setting, colors, mood, and harmless action from the original request.",
    "Simplify unsupported or overly complex rendering instructions. Do not add text, people, claims, or objects that were not requested.",
    "Original request:",
    prompt,
  ].join("\n");
}
