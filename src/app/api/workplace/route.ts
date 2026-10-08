import { NextResponse } from "next/server";
import { now } from "@/lib/clock";
import { Jev } from "@/lib/jev";
import { DEPTHS, SCOPES, sourceKey, type Depth, type Plan } from "@/lib/router";
import { userTransport } from "@/lib/auth";
import { Workplace, transportFor, type Transport } from "@/lib/workiq";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The workplace tool, and the one that needs routing. The other, search_web,
 * has a single reach and lives in /api/web.
 *
 * What the model sees is a single question in and an answer out. What happens
 * inside is the part worth having: Jev picks the cheapest reach that can
 * answer, so a question about the user's manager costs a one second record
 * read instead of a thirty second composed answer.
 *
 * The model is deliberately not given the choice of reach. It would have to be
 * told the cost of each one and trusted to care, and it would pay a round trip
 * to decide. Jev decides in the same call that parses the question.
 */

let jev: Jev | null = null;
let cli: Transport | null = null;

const PLACE = {
  timeZone: process.env.USER_TIME_ZONE ?? "UTC",
  countryOrRegion: process.env.USER_COUNTRY,
};

/** Raised when nobody is signed in and there is no CLI to fall back on. */
class NotSignedIn extends Error {}

/**
 * Whose Work IQ answers this request. A person signed in with Microsoft gets
 * their own. Otherwise the CLI on the machine serving the page answers, which
 * is the developer's own account and only exists on their machine.
 */
function workplace(request: Request): Workplace {
  jev ??= new Jev(process.env.TYPESAFE_API_KEY ?? "");
  const own = userTransport(request, PLACE);
  if (own) return new Workplace(jev, own);
  // One CLI, kept alive. It costs about three and a half seconds to start and
  // authenticate, and that is paid once rather than per question.
  if (!cli) {
    try {
      cli = transportFor(null, PLACE);
    } catch {
      throw new NotSignedIn("Sign in with Microsoft to ask about your work.");
    }
  }
  return new Workplace(jev, cli);
}

/**
 * Starts the Work IQ client ahead of the first question.
 *
 * The CLI takes about four seconds to start and sign in. Paid on the first
 * lookup, that lands in the middle of a spoken answer, and it made the first
 * routed lookup read 5.1s in a comparison where the warm figure is about 1s.
 * The page calls this when a conversation opens, while the person is still
 * drawing breath.
 */
export async function PUT(request: Request) {
  const started = Date.now();
  try {
    const transport = workplace(request).transport;
    await transport.list?.();
    return NextResponse.json({
      warm: true,
      seconds: (Date.now() - started) / 1000,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { warm: false, error: detail },
      { status: error instanceof NotSignedIn ? 401 : 500 },
    );
  }
}

export async function POST(request: Request) {
  const started = Date.now();
  try {
    const body = (await request.json()) as {
      question?: unknown;
      mode?: unknown;
      lane?: unknown;
      stream?: unknown;
    };
    const question = typeof body.question === "string" ? body.question : "";
    if (!question.trim()) {
      return NextResponse.json(
        { error: "No question was asked." },
        { status: 400 },
      );
    }

    // The two direct ways: Work IQ composing on its own, or a model holding
    // Work IQ's tools and choosing its calls. Used by the comparison, and as
    // the answering path itself when the person picks that mode on the page.
    // The model is never told these exist. Each carries the date, because the
    // model reads it either way.
    if (body.mode === "direct") {
      return NextResponse.json({
        ...(await workplace(request).direct(question)),
        now: now(),
      });
    }

    if (body.mode === "picks") {
      return NextResponse.json({
        ...(await workplace(request).picks(question)),
        now: now(),
      });
    }

    // A lane chosen in the UI. The model is never told this exists, so a
    // spoken question cannot change how far a lookup reaches.
    const forced = DEPTHS.find((depth) => depth === body.lane) ?? null;

    // Streamed as lines of JSON when asked: Jev's choice the moment it is
    // made, then the answer. The choice lands in well under a second and the
    // answer can take a minute, and the page shows the gap as it happens.
    if (body.stream) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const line = (value: unknown) =>
            controller.enqueue(encoder.encode(JSON.stringify(value) + "\n"));
          try {
            const answer = await workplace(request).answer(
              question,
              forced as Depth | null,
              (plan) => line({ type: "plan", routing: routing(plan) }),
            );
            line({ type: "done", ...payload(question, answer) });
          } catch (error) {
            line({
              type: "error",
              error: error instanceof Error ? error.message : String(error),
            });
          }
          controller.close();
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "application/x-ndjson",
          "Cache-Control": "no-store",
        },
      });
    }

    const answer = await workplace(request).answer(
      question,
      forced as Depth | null,
    );
    return NextResponse.json(payload(question, answer));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: detail, seconds: (Date.now() - started) / 1000 },
      { status: error instanceof NotSignedIn ? 401 : 500 },
    );
  }
}

function routing(plan: Plan) {
  return {
    seconds: plan.seconds,
    depth: plan.depth,
    record: plan.record,
    meaning: plan.meaning,
    scope: plan.scope,
    reach: plan.reachCertainty,
    sources: SCOPES.map((s) => ({
      id: s.id,
      probability: plan.checks[sourceKey(s.id)] ?? 0,
    })),
    particular: plan.checks.workplace_particular ?? null,
    narrowedFrom: plan.narrowedFrom,
    parts: plan.parts.map((p) => ({
      question: p.question,
      depth: p.plan.depth,
      record: p.plan.record,
      scope: p.plan.scope,
    })),
    forced: plan.forced,
    overruled: plan.overruled,
  };
}

/**
 * The trace is for the person watching, not for the model. The model is sent
 * `text` alone, so a reply can never carry routing state back in.
 */
function payload(
  question: string,
  answer: Awaited<ReturnType<Workplace["answer"]>>,
) {
  return {
    text: answer.text,
    now: now(),
    records: answer.records,
    foundNothing: answer.foundNothing,
    trace: {
      question,
      seconds: answer.seconds,
      routing: routing(answer.plan),
      steps: answer.steps,
    },
  };
}
