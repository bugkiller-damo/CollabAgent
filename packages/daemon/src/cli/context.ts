import { loadAgentContext } from "../auth.js";
import { ApiClient } from "../client.js";

export function getClient() {
  const ctx = loadAgentContext();
  return { ctx, client: new ApiClient(ctx) };
}
