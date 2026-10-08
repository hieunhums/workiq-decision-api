import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import type { ToolSpec, Transport } from "./transport";

/**
 * A long-lived connection to the WorkIQ CLI over its MCP stdio server.
 *
 * Spawning the client per question costs roughly three and a half seconds in
 * process start and authentication. One connection pays that once.
 *
 * This transport works on a developer machine, where the CLI holds a signed-in
 * account. It does not work in a container: the CLI's sign-in reaches for the
 * MSAL WAM broker, which has no Linux implementation, and does not fall back
 * to a device code. Use the A2A transport there.
 */
export class CliTransport implements Transport {
  readonly kind = "cli";

  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();

  constructor(
    private readonly executable: string,
    private readonly timeoutMs = 90_000,
  ) {}

  available(): boolean {
    return Boolean(this.executable) && existsSync(this.executable);
  }

  private start(): void {
    if (this.child) return;
    if (!this.available()) {
      throw new Error(`Set WORKIQ_PATH to the workiq executable. Not found: ${this.executable}`);
    }
    const child = spawn(this.executable, ["mcp"], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    child.on("exit", () => this.fail(new Error("The WorkIQ client stopped.")));
    child.on("error", (error) => this.fail(error));
    this.write({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "workiq-decision-api", version: "1" },
      },
    });
    this.write({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  }

  /** One reader owns stdout and hands each reply to the waiting caller. */
  private consume(chunk: string): void {
    this.buffer += chunk;
    let end = this.buffer.indexOf("\n");
    while (end !== -1) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      end = this.buffer.indexOf("\n");
      if (!line.trim()) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof message.id !== "number") continue;
      const waiting = this.pending.get(message.id);
      if (!waiting) continue;
      this.pending.delete(message.id);
      const failure = message.error as Record<string, unknown> | undefined;
      if (failure) {
        waiting.reject(new Error(String(failure.message ?? "The client reported an error.")));
      } else {
        waiting.resolve((message.result as Record<string, unknown>) ?? {});
      }
    }
  }

  private fail(error: Error): void {
    for (const waiting of this.pending.values()) waiting.reject(error);
    this.pending.clear();
    this.child = null;
  }

  private write(object: unknown): void {
    this.child?.stdin.write(`${JSON.stringify(object)}\n`);
  }

  async call(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    // Arguments are structured values, never a shell string, so retrieved or
    // spoken text cannot become another command.
    return this.request("tools/call", { name: tool, arguments: args });
  }

  /** The tools the client offers, with the schemas a model needs to call them. */
  async list(): Promise<ToolSpec[]> {
    const reply = await this.request("tools/list", {});
    const tools = Array.isArray(reply.tools) ? (reply.tools as Record<string, unknown>[]) : [];
    return tools
      .filter((tool) => typeof tool.name === "string")
      .map((tool) => ({
        name: String(tool.name),
        description: typeof tool.description === "string" ? tool.description : "",
        schema: (tool.inputSchema as Record<string, unknown>) ?? { type: "object" },
      }));
  }

  private request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.start();
    const id = (this.nextId += 1);
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("WorkIQ did not reply in time."));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  stop(): void {
    this.fail(new Error("The connection closed."));
    this.child?.kill();
    this.child = null;
  }
}
