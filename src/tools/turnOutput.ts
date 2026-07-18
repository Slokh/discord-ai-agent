import type { AgentTurnOutput, ToolContext } from "./types.js";

export function createAgentTurnOutput(): AgentTurnOutput {
  const files: AgentTurnOutput["files"] = [];
  const tables: AgentTurnOutput["tables"] = [];
  const footerLines: string[] = [];
  let presentation: AgentTurnOutput["presentation"];
  return {
    files,
    tables,
    footerLines,
    addFooterLines: (...lines) => {
      for (const line of lines.map((value) => value.trim()).filter(Boolean)) {
        if (!footerLines.includes(line)) footerLines.push(line);
      }
    },
    setPresentation: (value) => { presentation = value; },
    get presentation() { return presentation; },
    snapshot: () => Object.freeze({
      files: [...files],
      tables: [...tables],
      footerLines: [...footerLines],
      ...(presentation ? { presentation } : {}),
    }),
  };
}

export function ensureAgentTurnOutput(ctx: ToolContext): AgentTurnOutput {
  return (ctx.turnOutput ??= createAgentTurnOutput());
}
