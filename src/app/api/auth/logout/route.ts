import { NextResponse } from "next/server";
import { clearedCookie, signOut } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  await signOut(request);
  const response = NextResponse.json({ signedIn: false });
  response.headers.append("Set-Cookie", clearedCookie());
  return response;
}
