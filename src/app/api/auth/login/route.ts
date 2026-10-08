import { NextResponse } from "next/server";
import { authConfigured, signInUrl } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sends the browser to Microsoft's sign-in page. */
export async function GET(request: Request) {
  if (!authConfigured()) {
    return NextResponse.redirect(new URL("/?signin=unavailable", request.url));
  }
  return NextResponse.redirect(await signInUrl(request));
}
