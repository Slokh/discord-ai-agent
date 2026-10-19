import fs from "node:fs/promises";
import path from "node:path";
import type { SandboxEnv } from "./sandboxEnv.js";
import { sandboxProfileForTaskType } from "./sandboxProfiles.js";

export const SANDBOX_DISPLAY = ":99";
export const SANDBOX_SCREEN_SIZE = "1280x800";
export const MAX_DELIVERED_FILES = 4;

export type SandboxShimOptions = {
  /** Scratch workspace root; repository profiles work in their checkout instead. */
  workspaceDir?: string;
  /** Directory whose files are attached to the task's Discord result. */
  deliverDir?: string;
  /** Compiled `sandboxFetch.js` path, used by `agent-fetch`. */
  fetchScript?: string;
};

/**
 * Writes the intentionally small command surface exposed to the sandbox agent.
 * The profile decides which helpers exist; the agent reaches them through its
 * ordinary shell tool, so no profile needs a bespoke model-facing tool.
 */
export async function writeSandboxToolShims(
  toolShimDir: string,
  env: SandboxEnv,
  options: SandboxShimOptions = {},
): Promise<string[]> {
  await fs.mkdir(toolShimDir, { recursive: true });
  const profile = sandboxProfileForTaskType(env.taskType);
  const shims: Record<string, string> = {
    "agent-task-context": [
      "#!/bin/sh",
      "printf '%s\\n' \"Task ID: $TASK_ID\" \"Trace ID: $TRACE_ID\" \"Requested by: $REQUESTED_BY\"",
      profile.workspace === "repository"
        ? `printf '%s\\n' ${shellQuote(`Repository: ${env.githubRepository}`)} ${shellQuote(`Base branch: ${env.githubBaseBranch}`)} ${shellQuote(`Cache dir: ${env.sandboxCacheDir}`)}`
        : `printf '%s\\n' ${shellQuote(`Workspace: ${options.workspaceDir ?? ""}`)} ${shellQuote(`Sandbox profile: ${profile.name}`)}`,
      "",
    ].join("\n"),
  };
  if (profile.capabilities.dependencyCache) shims["agent-cache-info"] = cacheInfoShim(env);
  if (profile.capabilities.fileDownload && options.fetchScript) shims["agent-fetch"] = fetchShim(options);
  if (profile.capabilities.desktop) shims["agent-desktop"] = desktopShim(options);
  if (options.deliverDir) shims["agent-deliver"] = deliverShim(options.deliverDir);

  await Promise.all(
    Object.entries(shims).map(async ([name, content]) => {
      await fs.writeFile(path.join(toolShimDir, name), content, {
        encoding: "utf8",
        mode: 0o755,
      });
    }),
  );
  return Object.keys(shims);
}

function cacheInfoShim(env: SandboxEnv) {
  return [
    "#!/bin/sh",
    "set -eu",
    `cache_dir=${shellQuote(env.sandboxCacheDir)}`,
    "echo \"Cache dir: $cache_dir\"",
    "for name in repos npm node_modules locks; do",
    "  path=\"$cache_dir/$name\"",
    "  if [ -e \"$path\" ]; then",
    "    count=$(find \"$path\" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')",
    "    echo \"$name: $count entries\"",
    "  else",
    "    echo \"$name: missing\"",
    "  fi",
    "done",
    "",
  ].join("\n");
}

function fetchShim(options: SandboxShimOptions) {
  return [
    "#!/bin/sh",
    "# usage: agent-fetch <url> [directory]  -> prints {path, bytes, contentType, resolvedUrl}",
    "set -eu",
    `AGENT_WORKSPACE=${shellQuote(options.workspaceDir ?? "")} exec node ${shellQuote(options.fetchScript!)} "$@"`,
    "",
  ].join("\n");
}

function deliverShim(deliverDir: string) {
  return [
    "#!/bin/sh",
    `# usage: agent-deliver <file>...  -> attaches up to ${MAX_DELIVERED_FILES} files (screenshots, logs, outputs) to the Discord result`,
    "set -eu",
    `dir=${shellQuote(deliverDir)}`,
    "mkdir -p \"$dir\"",
    "[ \"$#\" -gt 0 ] || { echo 'usage: agent-deliver <file>...' >&2; exit 64; }",
    "for file in \"$@\"; do",
    "  [ -f \"$file\" ] || { echo \"not a file: $file\" >&2; exit 1; }",
    "  count=$(find \"$dir\" -mindepth 1 -maxdepth 1 -type f | wc -l | tr -d ' ')",
    `  if [ "$count" -ge ${MAX_DELIVERED_FILES} ]; then echo "already delivering ${MAX_DELIVERED_FILES} files; remove one from $dir first" >&2; exit 1; fi`,
    "  cp \"$file\" \"$dir/$(printf '%02d' \"$count\")-$(basename \"$file\")\"",
    "  echo \"will deliver $(basename \"$file\")\"",
    "done",
    "",
  ].join("\n");
}

function desktopShim(options: SandboxShimOptions) {
  const workspace = options.workspaceDir ?? "${TMPDIR:-/tmp}";
  return [
    "#!/bin/sh",
    "# Virtual display for running and operating GUI programs, including Windows .exe via Wine.",
    "#   agent-desktop start [WxH]        start the display (default " + SANDBOX_SCREEN_SIZE + ")",
    "#   agent-desktop run <cmd> [args]   launch a program on the display in the background (log: logs/<name>.log)",
    "#   agent-desktop screenshot [name]  save a PNG and print its path; inspect it with view_image",
    "#   agent-desktop windows            list visible window ids, titles and geometry",
    "#   agent-desktop focus <window-id>  raise and focus a window",
    "#   agent-desktop click <x> <y> [1|2|3] | move <x> <y> | scroll up|down [n]",
    "#   agent-desktop key <keys...>      e.g. Return, Escape, ctrl+s, Left Left Up",
    "#   agent-desktop hold <key> <secs>  hold a key down for a duration",
    "#   agent-desktop type <text>        type literal text",
    "#   agent-desktop wait <secs>        let the program run",
    "#   agent-desktop stop               stop the display and its programs",
    "set -eu",
    `export DISPLAY=${shellQuote(SANDBOX_DISPLAY)}`,
    `workspace=${options.workspaceDir ? shellQuote(workspace) : workspace}`,
    "export WINEPREFIX=\"$workspace/.wine\" WINEDEBUG=-all WINEDLLOVERRIDES='mscoree,mshtml='",
    "state=\"$workspace/.desktop\"",
    "mkdir -p \"$state\" \"$workspace/logs\" \"$workspace/screens\"",
    "running() { [ -f \"$state/xvfb.pid\" ] && kill -0 \"$(cat \"$state/xvfb.pid\")\" 2>/dev/null; }",
    "need() { running || { echo 'display is not running; use: agent-desktop start' >&2; exit 1; }; }",
    "cmd=${1:-}; [ \"$#\" -gt 0 ] && shift",
    "case \"$cmd\" in",
    "  start)",
    "    if running; then echo \"display already running on $DISPLAY\"; exit 0; fi",
    `    size=\${1:-${SANDBOX_SCREEN_SIZE}}`,
    "    Xvfb \"$DISPLAY\" -screen 0 \"${size}x24\" -nolisten tcp >\"$workspace/logs/xvfb.log\" 2>&1 &",
    "    echo $! >\"$state/xvfb.pid\"",
    "    i=0; until xdpyinfo >/dev/null 2>&1; do i=$((i+1)); [ $i -lt 50 ] || { echo 'display failed to start' >&2; exit 1; }; sleep 0.1; done",
    "    if command -v openbox >/dev/null 2>&1; then openbox >\"$workspace/logs/wm.log\" 2>&1 & echo $! >\"$state/wm.pid\"; fi",
    "    echo \"display running on $DISPLAY at $size\" ;;",
    "  run)",
    "    need; [ \"$#\" -gt 0 ] || { echo 'usage: agent-desktop run <cmd> [args]' >&2; exit 64; }",
    "    name=$(basename \"$1\" | tr -c 'A-Za-z0-9._-\\n' '_')",
    "    case \"$1\" in *.exe|*.EXE|*.msi|*.MSI) set -- wine \"$@\" ;; esac",
    "    nohup \"$@\" >\"$workspace/logs/$name.log\" 2>&1 &",
    "    echo $! >>\"$state/programs.pid\"",
    "    echo \"started pid $! ($*); log: $workspace/logs/$name.log\" ;;",
    "  screenshot)",
    "    need; file=\"$workspace/screens/${1:-screen-$(date +%s%3N)}.png\"",
    "    import -window root \"$file\" && echo \"$file\" ;;",
    "  windows)",
    "    need; for id in $(xdotool search --onlyvisible --name '.*' 2>/dev/null); do",
    "      printf '%s\\t%s\\t%s\\n' \"$id\" \"$(xdotool getwindowname \"$id\" 2>/dev/null)\" \"$(xdotool getwindowgeometry \"$id\" 2>/dev/null | tr '\\n' ' ')\"",
    "    done ;;",
    "  focus) need; xdotool windowactivate --sync \"$1\" 2>/dev/null || xdotool windowfocus \"$1\" ;;",
    "  click) need; xdotool mousemove \"$1\" \"$2\" click \"${3:-1}\" ;;",
    "  move) need; xdotool mousemove \"$1\" \"$2\" ;;",
    "  scroll) need; button=5; [ \"${1:-down}\" = up ] && button=4; xdotool click --repeat \"${2:-3}\" \"$button\" ;;",
    "  key) need; xdotool key --delay 60 \"$@\" ;;",
    "  hold) need; xdotool keydown \"$1\"; sleep \"$2\"; xdotool keyup \"$1\" ;;",
    "  type) need; xdotool type --delay 40 -- \"$*\" ;;",
    "  wait) sleep \"${1:-1}\" ;;",
    "  stop)",
    "    for file in \"$state/programs.pid\" \"$state/wm.pid\" \"$state/xvfb.pid\"; do",
    "      [ -f \"$file\" ] && xargs kill 2>/dev/null <\"$file\" || true; rm -f \"$file\"",
    "    done",
    "    command -v wineserver >/dev/null 2>&1 && wineserver -k 2>/dev/null || true",
    "    echo 'display stopped' ;;",
    "  *) sed -n '2,15p' \"$0\" | sed 's/^# \\{0,1\\}//'; [ -z \"$cmd\" ] || exit 64 ;;",
    "esac",
    "",
  ].join("\n");
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
