import { NextResponse } from "next/server";
import { VOICES, instructions, tools, type Voice } from "@/lib/agent";
import { webConfigured } from "@/lib/webiq";
import { foundryHost, foundryToken, realtimeModel, voiceConfigured } from "@/lib/foundry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Mints a short-lived key for one realtime session.
 *
 * The browser never holds a Foundry credential. It gets an ephemeral key that
 * expires in about a minute, scoped to a single session whose instructions and
 * tool list were fixed here, on the server. A page cannot widen its own tool
 * surface by editing what it sends.
 */
/** Whether voice is offered, so the page can hide it when it is not. */
export async function GET() {
  return NextResponse.json({ enabled: voiceConfigured() });
}

export async function POST(request: Request) {
  if (!voiceConfigured()) {
    return NextResponse.json({ error: "Voice is off on this server." }, { status: 404 });
  }
  try {
    const body = await request.json().catch(() => ({}) as Record<string, unknown>);
    const asked = body?.voice as string | undefined;
    const voice: Voice = VOICES.includes(asked as Voice) ? (asked as Voice) : "marin";

    const response = await fetch(
      `https://${foundryHost()}/openai/v1/realtime/client_secrets`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await foundryToken()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session: {
            type: "realtime",
            model: realtimeModel(),
            instructions: instructions(webConfigured()),
            tools: tools(webConfigured()),
            tool_choice: "auto",
            audio: {
              // Server turn detection, so the person can just talk.
              input: { turn_detection: { type: "server_vad", threshold: 0.5 } },
              output: { voice },
            },
          },
        }),
      },
    );

    if (!response.ok) {
      const detail = await response.text();
      return NextResponse.json(
        { error: `Foundry returned ${response.status}`, detail },
        { status: 502 },
      );
    }

    const payload = await response.json();
    return NextResponse.json({
      key: payload.value,
      expiresAt: payload.expires_at,
      model: realtimeModel(),
      host: foundryHost(),
      voice,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
