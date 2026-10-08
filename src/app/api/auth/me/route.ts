import { NextResponse } from "next/server";
import { authConfigured, signedIn } from "@/lib/auth";
import { CliTransport } from "@/lib/workiq";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Who the page is answering as. "user" is a person signed in with Microsoft,
 * "cli" is the Work IQ CLI on the machine serving the page, "none" is neither.
 */
export async function GET(request: Request) {
  const user = signedIn(request);
  const executable = process.env.WORKIQ_PATH ?? "";
  const cli = Boolean(executable) && new CliTransport(executable).available();
  return NextResponse.json(
    {
      configured: authConfigured(),
      cli,
      mode: user ? "user" : cli ? "cli" : "none",
      name: user?.name ?? null,
      username: user?.username ?? null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
