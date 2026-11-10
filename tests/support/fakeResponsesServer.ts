import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** One scripted model step: either run a Code Mode cell or answer. */
export type FakeModelStep =
  | { kind: "exec"; code: string }
  | { kind: "message"; text: string };

export type RecordedResponsesRequest = {
  path: string;
  body: Record<string, unknown>;
};

/**
 * A local stand-in for an OpenAI Responses endpoint (as reached through the
 * OpenRouter gateway). Each POST consumes the next scripted step and streams it
 * back as server-sent events, so the real nanocode host can run whole turns,
 * including Code Mode tool calls, without network access.
 */
export async function startFakeResponsesServer(script: (request: RecordedResponsesRequest, index: number) => FakeModelStep) {
  const requests: RecordedResponsesRequest[] = [];
  const server: Server = createServer(async (request, response) => {
    if (request.method !== "POST" || !request.url?.endsWith("/responses")) {
      response.writeHead(404).end();
      return;
    }
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
    const recorded = { path: request.url, body };
    requests.push(recorded);
    const step = script(recorded, requests.length - 1);
    const responseId = `resp_${requests.length}`;
    const item = step.kind === "exec"
      ? {
          type: "custom_tool_call",
          id: `ctc_${requests.length}`,
          call_id: `call_${requests.length}`,
          name: "exec",
          input: step.code,
          status: "completed",
        }
      : {
          type: "message",
          id: `msg_${requests.length}`,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: step.text, annotations: [] }],
        };
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (event: Record<string, unknown>) => response.write(`data: ${JSON.stringify(event)}\n\n`);
    send({ type: "response.created", response: { id: responseId, status: "in_progress" } });
    send({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress" } });
    send({ type: "response.output_item.done", output_index: 0, item });
    send({
      type: "response.completed",
      response: {
        id: responseId,
        status: "completed",
        output: [item],
        usage: {
          input_tokens: 120,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 30,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 150,
        },
      },
    });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
