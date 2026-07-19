import type { AgentResponse, ToolContext } from "../../tools/types.js";
import type { AgentToolRoute } from "../routerShared.js";

export type LocalToolHandler = (ctx: ToolContext, route: AgentToolRoute, originalText: string) => Promise<AgentResponse>;
