import { NextResponse } from "next/server";
import { instructions, tools } from "@/lib/agent";
import { now } from "@/lib/clock";
import { chatStream } from "@/lib/foundry";
import { webConfigured } from "@/lib/webiq";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The text mode. Same tools and rules as the voice call, answered by the chat
 * model instead, so a typed question needs no microphone and no session.
 *
 * The page runs the tools itself (through /api/workplace and /api/web, so the
 * cards and animations are the same as in a call) and sends the results back
 * here as ordinary tool messages. This route only talks to the model.
 *
 * Streams NDJSON: `{type:"delta", text}` as words arrive, then either
 * `{type:"tools", calls}` or `{type:"done"}`, or `{type:"error", error}`.
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}) as Record<string, unknown>);
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  if (!messages.length) return NextResponse.json({ error: "No messages." }, { status: 400 });

  const web = webConfigured();
  const system = `${instructions(web, "text")}\n\n${now()}`;
  const functions = tools(web).map(({ name, description, parameters }) => ({
    type: "function",
    function: { name, description, parameters },
  }));

  let upstream: Response;
  try {
    upstream = await chatStream({
      messages: [{ role: "system", content: system }, ...messages],
      tools: functions,
      tool_choice: "auto",
      parallel_tool_calls: false,
      reasoning_effort: "low",
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: detail }, { status: 502 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const write = (value: unknown) =>
        controller.enqueue(encoder.encode(JSON.stringify(value) + "\n"));
      const calls: { id: string; name: string; arguments: string }[] = [];
      try {
        const reader = upstream.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n");
          buffer = events.pop() ?? "";
          for (const event of events) {
            const data = event.startsWith("data:") ? event.slice(5).trim() : "";
            if (!data || data === "[DONE]") continue;
            const chunk = JSON.parse(data) as {
              choices?: {
                delta?: {
                  content?: string | null;
                  tool_calls?: {
                    index: number;
                    id?: string;
                    function?: { name?: string; arguments?: string };
                  }[];
                };
              }[];
            };
            const delta = chunk.choices?.[0]?.delta;
            if (delta?.content) write({ type: "delta", text: delta.content });
            for (const part of delta?.tool_calls ?? []) {
              const call = (calls[part.index] ??= { id: "", name: "", arguments: "" });
              if (part.id) call.id = part.id;
              if (part.function?.name) call.name += part.function.name;
              if (part.function?.arguments) call.arguments += part.function.arguments;
            }
          }
        }
        const made = calls.filter(Boolean);
        write(made.length ? { type: "tools", calls: made } : { type: "done" });
      } catch (error) {
        write({ type: "error", error: error instanceof Error ? error.message : String(error) });
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" },
  });
}
