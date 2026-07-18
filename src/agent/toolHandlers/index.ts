import { coreToolHandlers } from "./core.js";
import { discordRetrievalToolHandlers } from "./discord-retrieval.js";
import { opsToolHandlers } from "./ops.js";
import { discordActionToolHandlers } from "./discord-action.js";
import { codegenToolHandlers } from "./codegen.js";
import { imageToolHandlers } from "./image.js";
import { generatedDataToolHandlers } from "./generated-data.js";
import { spotifyToolHandlers } from "./spotify.js";

export const handlerDefinitions = {
  ...coreToolHandlers,
  ...discordRetrievalToolHandlers,
  ...opsToolHandlers,
  ...discordActionToolHandlers,
  ...codegenToolHandlers,
  ...imageToolHandlers,
  ...generatedDataToolHandlers,
  ...spotifyToolHandlers,
};
