import fs from "node:fs/promises";

type CacheEntry = {
  mtimeMs: number;
  size: number;
  content: string | undefined;
};

const cache = new Map<string, CacheEntry>();

/**
 * Loads the optional deployment prompt overlay file (default `.discord-ai-agent/prompt-overlay.md`).
 *
 * The overlay boundary keeps private persona/tone content out of tracked source: the base repo ships
 * neutral defaults, and per-deployment customization lives in this gitignored file (or DB overlays).
 * Returns undefined when the file is missing or empty. Content is cached per path and re-read only
 * when the file's mtime or size changes, so live edits apply without a restart.
 */
export async function loadPromptOverlayText(filePath: string | undefined): Promise<string | undefined> {
  const normalized = filePath?.trim();
  if (!normalized) return undefined;
  try {
    const stats = await fs.stat(normalized);
    const cached = cache.get(normalized);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached.content;
    const raw = await fs.readFile(normalized, "utf8");
    const content = raw.trim() || undefined;
    cache.set(normalized, { mtimeMs: stats.mtimeMs, size: stats.size, content });
    return content;
  } catch {
    cache.delete(normalized);
    return undefined;
  }
}

export function clearPromptOverlayCache() {
  cache.clear();
}
