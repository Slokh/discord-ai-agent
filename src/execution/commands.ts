import { execFile, spawn } from "node:child_process";
import { progress, recordArtifact, recordCommand } from "./callbacks.js";
import type { SandboxEnv } from "./sandboxEnv.js";
import { MAX_ACTIVITY_COMMAND_OUTPUT, MAX_CAPTURED_COMMAND_OUTPUT, formatDuration, tail } from "./sandboxUtils.js";

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export function execFileText(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(command, args, { cwd: options.cwd, env: options.env ?? process.env, maxBuffer: 1_000_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    displayCommand?: string;
    allowFailure?: boolean;
    taskEnv?: SandboxEnv;
    step?: string;
    onStdoutText?: (text: string) => void | Promise<void>;
  }
): Promise<CommandResult> {
  console.log(JSON.stringify({ event: "sandbox.command.start", command: options.displayCommand ?? command, args: options.displayCommand ? ["[displayed command redacted]"] : redactedArgs(command, args), cwd: options.cwd }));
  const startedAt = Date.now();
  const step = options.step ?? command;
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  const commandLine = options.displayCommand ?? `${command} ${redactedArgs(command, args).join(" ")}`.trim();
  const activityTimer =
    options.taskEnv && shouldEmitCommandActivity(step)
      ? setInterval(() => {
          void progress(options.taskEnv!, `${step}_activity`, `${step} is still running after ${formatDuration(Date.now() - startedAt)}.`, {
            command: commandLine,
            stdoutChars: stdout.length,
            stderrChars: stderr.length,
            stdoutTail: tail(stdout, MAX_ACTIVITY_COMMAND_OUTPUT),
            stderrTail: tail(stderr, MAX_ACTIVITY_COMMAND_OUTPUT),
            durationMs: Date.now() - startedAt
          }).catch(() => undefined);
        }, 30_000)
      : undefined;
  activityTimer?.unref?.();

  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stdout += text;
    if (options.onStdoutText) {
      void Promise.resolve(options.onStdoutText(text)).catch((error) => {
        console.error("Command stdout observer failed", error);
      });
    }
    process.stdout.write(text);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderr += text;
    process.stderr.write(text);
  });

  if (options.input) child.stdin.write(options.input);
  child.stdin.end();

  let exitCode: number;
  try {
    exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 1));
    });
  } finally {
    if (activityTimer) clearInterval(activityTimer);
  }
  if (options.onStdoutText) {
    await Promise.resolve(options.onStdoutText("\n")).catch((error) => {
      console.error("Command stdout observer failed while flushing", error);
    });
  }
  const duration = Date.now() - startedAt;
  await recordCommand(options.taskEnv, {
    step,
    command: commandLine,
    exitCode,
    outputTail: tail(stdout, MAX_CAPTURED_COMMAND_OUTPUT),
    errorTail: tail(stderr, MAX_CAPTURED_COMMAND_OUTPUT),
    durationMs: duration
  });
  await recordArtifact(options.taskEnv, {
    kind: "command_log",
    name: `${step} command log`,
    content: [`$ ${commandLine}`, stdout.trimEnd(), stderr.trimEnd(), `[exit ${exitCode} in ${formatDuration(duration)}]`]
      .filter(Boolean)
      .join("\n"),
    contentType: "text/plain",
    metadata: { step, command: commandLine, exitCode }
  });
  if (exitCode !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${exitCode}: ${stderr || stdout}`);
  }
  return { exitCode, stdout, stderr, durationMs: duration };
}

function shouldEmitCommandActivity(step: string) {
  return (
    step === "codex" ||
    step.startsWith("codex_attempt_") ||
    step === "opencode" ||
    step.startsWith("opencode_attempt_") ||
    step === "verify" ||
    step === "scan" ||
    step === "dependencies"
  );
}

function redactedArgs(command: string, args: string[]) {
  if (command === "git" && args[0] === "clone") {
    return args.map((arg) => arg.replace(/x-access-token:[^@]+@/g, "x-access-token:[redacted]@"));
  }
  return args;
}
