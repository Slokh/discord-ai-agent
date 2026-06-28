import { assertOpenRouterConfig, loadConfig } from "../src/config/env.js";
import { OpenRouterClient } from "../src/models/openrouter.js";

async function main() {
  const config = loadConfig();
  assertOpenRouterConfig(config);
  const client = new OpenRouterClient(config.openRouter);

  const chat = await client.chat({
    messages: [{ role: "user", content: "Reply with exactly: discord-ai-agent-ok" }],
    maxTokens: 96,
    temperature: 0
  });
  process.stdout.write(`chat ok: ${chat.model} -> ${chat.content.trim()}\n`);
  if (chat.content.trim() !== "discord-ai-agent-ok") {
    throw new Error(`Expected chat smoke response "discord-ai-agent-ok", got "${chat.content.trim()}".`);
  }

  const [embedding] = await client.embed(
    ["discord ai agent embedding smoke test"],
    config.openRouter.embeddingModel,
    config.embeddingDimensions
  );
  process.stdout.write(`embedding ok: ${config.openRouter.embeddingModel} -> ${embedding?.length ?? 0} dimensions\n`);
  if (!embedding || embedding.length !== config.embeddingDimensions) {
    throw new Error(`Expected ${config.embeddingDimensions} embedding dimensions.`);
  }

  if (process.env.SMOKE_OPENROUTER_IMAGE === "true") {
    const image = await client.generateImage("a tiny blue square icon labeled CM");
    process.stdout.write(`image ok: ${image.model} -> ${image.data.length} result(s)\n`);
  } else {
    process.stdout.write("image skipped: set SMOKE_OPENROUTER_IMAGE=true to test image generation\n");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
