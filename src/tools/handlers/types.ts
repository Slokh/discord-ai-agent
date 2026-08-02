import type { AgentResponse, ToolContext } from "../types.js";
import type { AgentToolRoute } from "../../agent/routerShared.js";

export type LocalToolHandler = (ctx: ToolContext, route: AgentToolRoute, originalText: string) => Promise<AgentResponse>;
