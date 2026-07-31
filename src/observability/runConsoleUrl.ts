export function isConfiguredRunConsoleUrl(
  value: string,
  configuredPublicUrl: string | null | undefined,
) {
  if (!configuredPublicUrl) return false;
  try {
    const candidate = new URL(value);
    const configured = new URL(configuredPublicUrl);
    if (candidate.origin !== configured.origin) return false;

    const configuredPath = configured.pathname.replace(/\/+$/, "");
    const runPrefix = `${configuredPath}/runs/`.replace(/^\/\//, "/");
    const runReference = candidate.pathname.startsWith(runPrefix)
      ? candidate.pathname.slice(runPrefix.length)
      : "";
    return Boolean(
      runReference &&
      !runReference.includes("/") &&
      !candidate.username &&
      !candidate.password
    );
  } catch {
    return false;
  }
}
