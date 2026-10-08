import { NextResponse } from "next/server";
import { now } from "@/lib/clock";
import { searchWeb, webConfigured } from "@/lib/webiq";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The web tool. One reach, so nothing to route: the model's query goes to Web
 * IQ as it is, and the passages come back with the date on top, because "the
 * latest" means nothing to a model that does not know when now is.
 */
/** Whether the web tool is offered, so the page can say so. */
export async function GET() {
  return NextResponse.json({ enabled: webConfigured() });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}) as Record<string, unknown>);
  const query = String(body?.query ?? "").trim();
  if (!query) return NextResponse.json({ error: "No query." }, { status: 400 });

  try {
    const show = body?.show === "images" || body?.show === "videos" ? body.show : null;
    const answer = await searchWeb(query, show);
    return NextResponse.json({ ...answer, now: now() });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: detail }, { status: 502 });
  }
}
