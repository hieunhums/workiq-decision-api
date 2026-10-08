import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";

/**
 * Tokens for the Foundry realtime endpoint.
 *
 * On a developer machine this picks up the `az` sign-in. In a container it
 * picks up the managed identity, with no secret anywhere. That works because
 * the realtime session is created as the *application*, not as the user: the
 * browser never sees anything but a short-lived ephemeral key.
 *
 * Note the scope. Every other call to this resource uses
 * `https://cognitiveservices.azure.com`, but the realtime client secret
 * endpoint wants `https://ai.azure.com`. Using the usual one returns 401 and
 * the message does not say why.
 */
const REALTIME_SCOPE = "https://ai.azure.com/.default";

let credential: TokenCredential | null = null;
let cached: { token: string; expiresAt: number } | null = null;

function credentials(): TokenCredential {
  credential ??= new DefaultAzureCredential();
  return credential;
}

export async function foundryToken(): Promise<string> {
  // A margin, so a token that is about to expire is not handed to a session
  // that will outlive it.
  const now = Date.now();
  if (cached && now < cached.expiresAt - 120_000) return cached.token;
  const issued = await credentials().getToken(REALTIME_SCOPE);
  if (!issued) throw new Error("Could not obtain a Foundry token.");
  cached = { token: issued.token, expiresAt: issued.expiresOnTimestamp };
  return issued.token;
}

export function foundryHost(): string {
  const host = process.env.FOUNDRY_HOST;
  if (!host) throw new Error("Set FOUNDRY_HOST to the Foundry resource hostname.");
  return host;
}

/** Voice is offered only when a realtime deployment is named. Text needs none. */
export function voiceConfigured(): boolean {
  return Boolean(process.env.REALTIME_DEPLOYMENT);
}

export function realtimeModel(): string {
  const model = process.env.REALTIME_DEPLOYMENT;
  if (!model) throw new Error("Voice is off. Set REALTIME_DEPLOYMENT to turn it on.");
  return model;
}

/**
 * The text model: it answers typed questions when no call is live, and plays
 * the comparison lane that picks its own tools. Never on the path to a spoken
 * answer.
 */
export function chatModel(): string {
  return process.env.CHAT_DEPLOYMENT ?? "gpt-5.4-mini";
}

/**
 * A streamed chat completion, returned as the raw server-sent events. Used by
 * the text mode, where the first words matter more than the whole reply.
 */
export async function chatStream(body: Record<string, unknown>): Promise<Response> {
  const token = await foundryToken();
  const response = await fetch(`https://${foundryHost()}/openai/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ model: chatModel(), stream: true, ...body }),
  });
  if (!response.ok || !response.body) {
    const payload = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(payload.error?.message ?? `The model returned ${response.status}.`);
  }
  return response;
}

/** One chat completion against the same resource and token as realtime. */
export async function chat(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`https://${foundryHost()}/openai/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await foundryToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: chatModel(), ...body }),
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const detail = (payload.error as { message?: string } | undefined)?.message;
    throw new Error(detail ?? `The model returned ${response.status}.`);
  }
  return payload;
}
