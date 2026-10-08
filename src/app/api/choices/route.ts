import { NextResponse } from "next/server";
import { ASK_WORKPLACE, SEARCH_WEB } from "@/lib/agent";
import { EXPECTED, RECORDS, SCOPES, TOOL_FOR, questions, sourceKey } from "@/lib/router";
import { webConfigured } from "@/lib/webiq";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type Option = {
  id: string;
  /** What the chooser is told this option means, verbatim. */
  meaning: string;
  /** What choosing it costs or runs. */
  detail?: string;
  cost?: string;
  enabled?: boolean;
};

export type Choice = {
  key: string;
  who: string;
  /** The question the chooser is asked, verbatim. */
  asks: string;
  options: Option[];
  none?: string;
};

/**
 * Every choice made on the way to an answer, with the exact words each chooser
 * is given. Built from the same objects the session and the router send, so
 * what the page shows is what the models read, not a paraphrase of it.
 */
export async function GET() {
  const web = webConfigured();
  const [reach, record, ...checks] = questions();
  const named = new Map(checks.map((c) => [c.key, c.instructions]));
  const path = new Map(RECORDS.map((r) => [r.id, r.path]));
  const wire = new Map<string, string>(SCOPES.map((s) => [s.id, s.wire]));

  const choices: Choice[] = [
    {
      key: "tool",
      who: "gpt-realtime-2.1, the voice model",
      asks: "Which tool, if any, answers what the person just said? Chosen from each tool's description.",
      options: [
        {
          id: ASK_WORKPLACE.name,
          meaning: ASK_WORKPLACE.description,
          detail: "Question passed word for word, then routed by Jev below.",
          cost: "1 to 60s",
          enabled: true,
        },
        {
          id: SEARCH_WEB.name,
          meaning: SEARCH_WEB.description,
          detail: "The model writes its own query. Web IQ sonic, one call, no routing.",
          cost: "<1s",
          enabled: web,
        },
      ],
      none: "No tool: it answers from the conversation alone, such as a greeting or a follow-up on something already said.",
    },
    {
      key: reach.key,
      who: "Jev",
      asks: reach.instructions,
      options: reach.options.map((o) => ({
        id: o.id,
        meaning: o.description,
        detail: `Work IQ ${TOOL_FOR[o.id as keyof typeof TOOL_FOR]}`,
        cost: EXPECTED[o.id as keyof typeof EXPECTED],
      })),
    },
    {
      key: record.key,
      who: "Jev, used only when the reach is record",
      asks: record.instructions,
      options: record.options.map((o) => ({
        id: o.id,
        meaning: o.description,
        detail: `GET ${decodeURIComponent(path.get(o.id) ?? "")}`,
      })),
      none: `${record.noneDescription} The lookup searches instead.`,
    },
    {
      key: "workplace_sources",
      who: "Jev, one yes or no question per source, in the same call",
      asks:
        "Each source is asked about on its own. Every source the question names is searched, in one call.",
      options: SCOPES.map((s) => ({
        id: s.id,
        meaning: named.get(sourceKey(s.id)) ?? "",
        detail: `retrieve, source ${wire.get(s.id)}`,
      })),
      none:
        "No source named, or more than three: everything is searched. A record that names one particular thing is searched in the record's own source instead.",
    },
  ];

  return NextResponse.json({ choices, web });
}
