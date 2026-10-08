import type { Transport } from "./transport";

/**
 * The container transport. No CLI, no broker, no libicu.
 *
 * Work IQ is an HTTP service and the CLI is only a wrapper around it. The
 * wrapper is the part that cannot be containerised: its sign-in reaches for
 * the MSAL WAM broker, which has no Linux implementation. Calling the service
 * directly removes that problem entirely.
 *
 * Two endpoints are used, because the fast path and the composing path are
 * different services:
 *
 * - `fetch` and `retrieve` go to Microsoft Graph. A record read is a Graph
 *   read; the CLI's own `fetch` does nothing more than this. Keeping it here
 *   preserves the one second record path that makes routing worth doing.
 * - `ask` goes to the Work IQ A2A gateway, which is the only place the
 *   composing answer exists.
 *
 * Both are delegated calls made as the signed-in user, from a token obtained
 * by the On-Behalf-Of exchange. There is no app-only flow for Work IQ, and
 * there cannot be: a container has no mailbox of its own to read.
 */

const WORKIQ_ENDPOINT = "https://workiq.svc.cloud.microsoft/a2a/";
const WORKIQ_AUDIENCE = "api://workiq.svc.cloud.microsoft";
export const WORKIQ_SCOPE = `${WORKIQ_AUDIENCE}/WorkIQAgent.Ask`;
const GRAPH = "https://graph.microsoft.com/v1.0";

/** Supplies the delegated tokens for one signed-in user. */
export type Tokens = {
  /** A token whose audience is the Work IQ gateway. */
  workiq(): Promise<string>;
  /** A token whose audience is Microsoft Graph. */
  graph(): Promise<string>;
};

export type Place = {
  timeZone: string;
  countryOrRegion?: string;
};

export class ServiceTransport implements Transport {
  readonly kind = "service";

  /** Kept so a follow-up question continues the same Work IQ conversation. */
  private contextId: string | null = null;

  constructor(
    private readonly tokens: Tokens,
    private readonly place: Place = { timeZone: "UTC" },
    private readonly timeoutMs = 90_000,
  ) {}

  async call(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (tool === "fetch") return this.fetchRecords(args);
    if (tool === "retrieve") return this.search(args);
    if (tool === "ask") return this.ask(args);
    throw new Error(`Unknown tool ${tool}.`);
  }

  /** A record read, straight from the entity path the router chose. */
  private async fetchRecords(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const urls = (args.entityUrls as string[]) ?? [];
    const token = await this.tokens.graph();
    const results = await Promise.all(
      urls.map(async (path) => {
        const response = await fetch(`${GRAPH}${path}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            // Graph needs the zone to render a naked local time correctly.
            Prefer: `outlook.timezone="${this.place.timeZone}"`,
          },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) {
          throw new Error(
            `Graph returned HTTP ${response.status} for ${path}${await graphReason(response)}.`,
          );
        }
        return { data: await response.json() };
      }),
    );
    // Shaped like the MCP reply so one record reader serves both transports.
    return { structuredContent: { results } };
  }

  /**
   * A scoped search. Graph's own search takes entity types rather than Work
   * IQ capability names, so the router's scope is mapped here.
   */
  private async search(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const query = String(args.query ?? "");
    const capabilities =
      (args.capabilities as { name: string }[] | undefined) ?? [];
    const entityTypes = capabilities.length
      ? capabilities.flatMap((c) => GRAPH_ENTITIES[c.name] ?? [])
      : ["message", "event", "driveItem", "chatMessage", "person"];
    const token = await this.tokens.graph();
    // Graph refuses some mixes in one request: people only on their own, and
    // files never alongside mail, chats or events. So each family is its own
    // request, in parallel, and a family that fails (a person with no
    // mailbox, say) does not sink the ones that answered.
    const families = SEARCH_FAMILIES.map((family) =>
      family.filter((type) => entityTypes.includes(type)),
    ).filter((family) => family.length);
    const replies = await Promise.allSettled(
      families.map(async (types) => {
        const response = await fetch(`${GRAPH}/search/query`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            requests: [
              {
                entityTypes: types,
                query: { queryString: query },
                from: 0,
                size: 15,
              },
            ],
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) {
          throw new Error(
            `Graph search for ${types.join(", ")} returned HTTP ${response.status}${await graphReason(response)}.`,
          );
        }
        return ((await response.json()) as GraphSearch).value?.[0]
          ?.hitsContainers?.[0];
      }),
    );
    const answered = replies.flatMap((r) =>
      r.status === "fulfilled" ? [r.value] : [],
    );
    if (!answered.length) {
      const first = replies.find((r) => r.status === "rejected") as
        PromiseRejectedResult | undefined;
      throw first?.reason ?? new Error("Graph search had nothing to search.");
    }
    const results = answered.flatMap((hits) =>
      (hits?.hits ?? []).map((hit) => ({ data: hit.resource })),
    );
    // The count is stated in the text so the caller can tell "nothing was
    // found" apart from "the look failed", which reads the same otherwise.
    const total = answered.reduce(
      (sum, hits) => sum + (hits?.total ?? hits?.hits?.length ?? 0),
      0,
    );
    return {
      structuredContent: { results },
      content: [{ type: "text", text: `Result Count: ${total}` }],
    };
  }

  /** The composing answer, over the A2A gateway. */
  private async ask(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const question = String(args.question ?? "");
    const token = await this.tokens.workiq();
    const body = {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "SendMessage",
      params: {
        message: {
          messageId: crypto.randomUUID(),
          role: "ROLE_USER",
          content: [{ text: question }],
          ...(this.contextId ? { contextId: this.contextId } : {}),
        },
        metadata: {
          // Without this the gateway cannot ground "today" or "this week", and
          // every time-sensitive question is answered against nothing.
          location: {
            timeZone: this.place.timeZone,
            ...(this.place.countryOrRegion
              ? { countryOrRegion: this.place.countryOrRegion }
              : {}),
          },
        },
      },
    };
    const response = await fetch(WORKIQ_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        // Without this header the gateway answers as v0.3 and returns
        // -32601 Method not found for SendMessage.
        "A2A-Version": "1.0",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(
        `Work IQ returned HTTP ${response.status}: ${await response.text()}`,
      );
    }
    const payload = (await response.json()) as A2AReply;
    if (payload.error) {
      throw new Error(
        `Work IQ reported ${payload.error.code}: ${payload.error.message}`,
      );
    }
    const task = payload.result?.task;
    if (task?.contextId) this.contextId = task.contextId;
    const text = (task?.artifacts ?? [])
      .flatMap((artifact) => artifact.parts ?? [])
      .map((part) => part.text ?? "")
      .filter(Boolean)
      .join("\n");
    return { content: [{ type: "text", text }] };
  }
}

/** Work IQ capability names mapped to the entity types Graph search accepts. */
const GRAPH_ENTITIES: Record<string, string[]> = {
  People: ["person"],
  Meetings: ["event"],
  OneDriveAndSharePoint: ["driveItem", "listItem"],
  Email: ["message"],
  TeamsMessages: ["chatMessage"],
};

/** Entity types Graph will search together in one request. */
const SEARCH_FAMILIES = [
  ["message", "chatMessage", "event"],
  ["driveItem", "listItem"],
  ["person"],
];

/** Graph's own words for a refusal, which say far more than the status. */
async function graphReason(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string };
    };
    const reason = body.error?.message || body.error?.code;
    return reason ? `: ${reason.slice(0, 200).replace(/\.+$/, "")}` : "";
  } catch {
    return "";
  }
}

type GraphSearch = {
  value?: {
    hitsContainers?: {
      total?: number;
      hits?: { resource?: Record<string, unknown> }[];
    }[];
  }[];
};

type A2AReply = {
  error?: { code: number; message: string };
  result?: {
    task?: {
      contextId?: string;
      artifacts?: { parts?: { text?: string }[] }[];
    };
  };
};
