export function normalizeOpenRouterModelId(value: string | undefined): string | null {
  const model = cleanModelArgument(value ?? "");
  if (model.length < 3 || model.length > 200) return null;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(model)
    ? model
    : null;
}

export function cleanModelArgument(value: string): string {
  return value.trim()
    .replace(/^`([^`]+)`$/, "$1")
    .replace(/^<([^<>]+)>$/, "$1")
    .trim();
}
