import { NextResponse } from "next/server";
import { finishSignIn, sessionCookie } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Where Microsoft sends the browser back with a code to redeem. */
export async function GET(request: Request) {
  try {
    const id = await finishSignIn(request);
    const response = NextResponse.redirect(new URL("/", request.url));
    response.headers.append("Set-Cookie", sessionCookie(id, request));
    return response;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const back = new URL("/", request.url);
    back.searchParams.set("signin", detail.slice(0, 300));
    return NextResponse.redirect(back);
  }
}
