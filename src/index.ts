import { routeAgentRequest } from "agents";

export { CodexAgent } from "./agent";
export { ReviewWorkflow } from "./workflow";

export default {
  async fetch(request, env) {
    // /agents/codex-agent/<room> -> the CodexAgent Durable Object (HTTP + WebSocket).
    // Everything else is served from ./public by the assets binding.
    const response = await routeAgentRequest(request, env);
    return response ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
