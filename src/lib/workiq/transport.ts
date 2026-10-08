/**
 * What a WorkIQ transport must do.
 *
 * Two exist. The CLI transport speaks MCP over stdio to a signed-in `workiq`
 * binary and works on a developer machine. The A2A transport speaks JSON-RPC
 * over HTTPS to the Work IQ gateway and is the only one that works in a
 * container, because the CLI cannot sign in there.
 */
export type ToolSpec = {
  name: string;
  description: string;
  schema: Record<string, unknown>;
};

export interface Transport {
  readonly kind: string;
  /**
   * Call a retrieval tool. `tool` is one of `fetch`, `retrieve` or `ask`, and
   * the arguments are the structured values the router composed.
   *
   * Returns the raw MCP-shaped result, which the record reader turns into text.
   */
  call(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  /**
   * The tools the client offers. Optional: only the CLI speaks MCP and can
   * list them. It exists for the comparison lane that lets a model choose its
   * own calls, and nothing on the answering path depends on it.
   */
  list?(): Promise<ToolSpec[]>;
}
