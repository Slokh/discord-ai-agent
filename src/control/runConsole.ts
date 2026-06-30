import fs from "node:fs/promises";
import path from "node:path";

const CONSOLE_DIST_DIR = path.join(process.cwd(), "dist", "console");

export async function renderRunConsolePage() {
  const indexPath = path.join(CONSOLE_DIST_DIR, "index.html");
  try {
    return await fs.readFile(indexPath, "utf8");
  } catch {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent Runs</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #080a0d; color: #eef3f7; font: 14px/1.5 system-ui, sans-serif; }
    main { width: min(560px, calc(100vw - 32px)); border: 1px solid #26303a; border-radius: 8px; padding: 24px; background: #10151b; }
    code { color: #8fd6bd; }
  </style>
</head>
<body>
  <main>
    <h1>Agent Runs</h1>
    <p>The console frontend has not been built yet.</p>
    <p>Run <code>npm run console:build</code> for production assets or <code>npm run console:dev</code> while iterating locally.</p>
  </main>
</body>
</html>`;
  }
}

export async function readRunConsoleAsset(urlPathname: string): Promise<{ body: Buffer; contentType: string } | undefined> {
  const prefix = "/console/";
  if (!urlPathname.startsWith(prefix)) return undefined;
  const relative = decodeURIComponent(urlPathname.slice(prefix.length));
  if (!relative || relative.includes("..") || path.isAbsolute(relative)) return undefined;
  const filePath = path.join(CONSOLE_DIST_DIR, relative);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(CONSOLE_DIST_DIR))) return undefined;
  try {
    const body = await fs.readFile(resolved);
    return { body, contentType: contentTypeForPath(resolved) };
  } catch {
    return undefined;
  }
}

function contentTypeForPath(filePath: string) {
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}
