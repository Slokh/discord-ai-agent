import { coreToolHandlers } from "./core.js";
import { discordRetrievalToolHandlers } from "./discord-retrieval.js";
import { opsToolHandlers } from "./ops.js";
import { discordActionToolHandlers } from "./discord-action.js";
import { codegenToolHandlers } from "./codegen.js";
import { imageToolHandlers } from "./image.js";
import { generatedDataToolHandlers } from "./generated-data.js";
import { spotifyToolHandlers } from "./spotify.js";
import { walletToolHandlers } from "./wallet.js";

export const handlerFamilies = {
  core: coreToolHandlers,
  discordRetrieval: discordRetrievalToolHandlers,
  ops: opsToolHandlers,
  discordAction: discordActionToolHandlers,
  codegen: codegenToolHandlers,
  image: imageToolHandlers,
  generatedData: generatedDataToolHandlers,
  spotify: spotifyToolHandlers,
  wallet: walletToolHandlers,
} as const;

type UnionToIntersection<T> = (T extends unknown ? (value: T) => void : never) extends (value: infer I) => void ? I : never;

export const handlerDefinitions = Object.assign({}, ...Object.values(handlerFamilies)) as UnionToIntersection<
  (typeof handlerFamilies)[keyof typeof handlerFamilies]
>;
