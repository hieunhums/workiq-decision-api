import { Jev } from "../jev";
import {
  args as argsFor,
  check,
  type Depth,
  plan as routePlan,
  type Plan,
  TOOL_FOR,
} from "../router";
import { CliTransport } from "./cli";
import { modelPicks, type Picked } from "./picks";
import { content, readableReply, resultCount, structured, type Field } from "./records";
import { ServiceTransport, type Place, type Tokens } from "./service";
import type { Transport } from "./transport";

type Step = {
  what: string;
  tool: string;
  args: Record<string, unknown>;
  seconds: number;
  found: number | null;
  bytes: number;
};

export type Answer = {
  text: string;
  /** The records as fields, when the answer was a record read. For layout only. */
  records: Field[][] | null;
  plan: Plan;
  steps: Step[];
  seconds: number;
  /** Whether the look succeeded but turned up nothing. Not the same as failing. */
  foundNothing: boolean;
};

/**
 * Answers a workplace question by choosing how far to reach before reaching.
 *
 * The ladder below is the whole point. Each rung is paid only when the one
 * before it came back with nothing:
 *
 *   1. Read one record, or search one named source. About 1s or about 10s.
 *   2. If a narrowed search found nothing, run it again unscoped. This is
 *      free: it is the same call without a filter.
 *   3. If something came back, Jev is asked whether it holds what was asked.
 *      About 0.3s. A doubted result is asked again of the composing reach,
 *      unless a lane was chosen by hand.
 *   4. Report any emptiness plainly, and let the model decide whether to ask
 *      again more broadly.
 *
 * A question making several requests is cut into them, and each one runs
 * this ladder on its own, at the same time.
 *
 * An empty result is the trigger, not a low confidence score. Measured over
 * 102 questions, Jev's confidence separates right from wrong routings far too
 * poorly to hang an expensive retry on: right routings ran as low as 0.10 and
 * wrong ones as high as 0.71.
 */
export class Workplace {
  constructor(
    private readonly jev: Jev,
    readonly transport: Transport,
  ) {}

  /**
   * `onPlan` hears Jev's decision before anything is fetched, so the page can
   * show the choice while Work IQ is still reaching.
   */
  async answer(
    question: string,
    forced: Depth | null = null,
    onPlan?: (plan: Plan) => void,
  ): Promise<Answer> {
    const started = Date.now();
    const trimmed = question.trim();
    if (!trimmed) throw new Error("No question was asked.");

    const plan = await routePlan(this.jev, trimmed, forced);
    onPlan?.(plan);
    const steps: Step[] = [];

    if (plan.parts.length) {
      const replies = await Promise.all(
        plan.parts.map((part, i) =>
          this.gather(part.plan, part.question, steps, forced, `Request ${i + 1}: `),
        ),
      );
      // Each answer is kept under the request it answers, so the model can
      // say which is which.
      const text = plan.parts
        .map((part, i) => `Request ${i + 1}: ${part.question}\n${replies[i].text}`)
        .join("\n\n");
      return {
        text,
        records: null,
        plan,
        steps,
        seconds: (Date.now() - started) / 1000,
        foundNothing: replies.every((r) => r.found === 0),
      };
    }

    const reply = await this.gather(plan, trimmed, steps, forced, "");
    return {
      text: reply.text,
      records: reply.records,
      plan,
      steps,
      seconds: (Date.now() - started) / 1000,
      foundNothing: reply.found === 0,
    };
  }

  /** One request through the ladder: the planned look, widening, the check. */
  private async gather(
    plan: Plan,
    question: string,
    steps: Step[],
    forced: Depth | null,
    label: string,
  ): Promise<{ text: string; found: number | null; records: Field[][] | null }> {
    let reply = await this.run(plan, question, steps, label + describe(plan));
    // What actually ran, so the check is told what was searched.
    let looked = plan;

    // A narrowed search that found nothing is a failed guess, not an answer.
    // Widening costs one more search and no thought.
    if (reply.found === 0 && plan.scopes.length) {
      looked = { ...plan, scopes: [], scope: null };
      reply = await this.run(looked, question, steps, label + "Nothing there, searching everywhere");
    }
    if (plan.depth === "reasoned" || reply.found === 0 || !reply.text.trim()) return reply;
    // An empty list of the person's own is an answer: they have none. Only a
    // search can miss what exists.
    if (plan.depth === "record" && reply.records?.length === 0) return reply;

    // If the check itself fails, nothing is doubted.
    const started = Date.now();
    const verdict = await check(this.jev, question, reply.text, looked).catch(() => null);
    if (!verdict) return reply;
    steps.push({
      what: label + (verdict.holds ? "Jev: this answers it" : `Jev doubts it: ${verdict.reason}`),
      tool: "jev",
      args: { answered: verdict.answered, ambiguous: verdict.ambiguous },
      seconds: (Date.now() - started) / 1000,
      found: null,
      bytes: 0,
    });
    // A lane chosen by hand is kept to, so the doubt is shown and not acted on.
    if (verdict.holds || forced) return reply;
    const deeper: Plan = { ...plan, depth: "reasoned" };
    return this.run(deeper, question, steps, label + "Asking the composing reach instead").catch(
      () => reply,
    );
  }

  /**
   * The same question with no routing at all: straight to the composing
   * answer, the way it would be asked without any of this.
   *
   * This exists to be compared against, and it is never on the answering path.
   * It is run only when someone asks to see the difference, because it costs
   * the very thing the router is there to avoid. Claiming a speedup without
   * measuring one would be the easy version of this, and worthless.
   */
  async direct(question: string): Promise<{ text: string; seconds: number }> {
    const trimmed = question.trim();
    if (!trimmed) throw new Error("No question was asked.");
    const started = Date.now();
    const { raw } = await this.read("ask", { question: trimmed });
    return { text: readableReply(raw), seconds: (Date.now() - started) / 1000 };
  }

  /** The comparison lane where a model picks its own calls. See picks.ts. */
  picks(question: string): Promise<Picked> {
    return modelPicks(this.transport, question);
  }

  private async run(
    plan: Plan,
    question: string,
    steps: Step[],
    what: string,
  ): Promise<{ text: string; found: number | null; records: Field[][] | null }> {
    const tool = TOOL_FOR[plan.depth];
    const args = argsFor(plan, question);
    const started = Date.now();
    const { result, raw } = await this.read(tool, args);
    const text = readableReply(raw);
    const found = resultCount(raw);
    steps.push({
      what,
      tool,
      args,
      seconds: (Date.now() - started) / 1000,
      found,
      bytes: raw.length,
    });
    return { text, found, records: structured(result) };
  }

  /** One Work IQ call, failing loudly on an error or a reply with nothing to read. */
  private async read(tool: string, args: Record<string, unknown>) {
    const result = await this.transport.call(tool, args);
    if (result.isError === true) {
      throw new Error(content(result) ?? "WorkIQ reported an unspecified error.");
    }
    const raw = content(result);
    if (raw === null) throw new Error("WorkIQ returned no usable content.");
    return { result, raw };
  }
}

function describe(plan: Plan): string {
  if (plan.depth === "record") return `Reading ${plan.record}`;
  if (plan.depth === "reasoned") return "Composing an answer";
  const from = plan.narrowedFrom ? ` instead of reading ${plan.narrowedFrom}` : "";
  return (plan.scope ? `Searching ${plan.scope}` : "Searching everywhere") + from;
}

/**
 * Picks a transport from the environment.
 *
 * The CLI is used when one is configured and present, which is the developer
 * machine. Everywhere else, and always in a container, the service transport
 * is used.
 */
export function transportFor(tokens: Tokens | null, place: Place): Transport {
  const executable = process.env.WORKIQ_PATH ?? "";
  if (executable) {
    const cli = new CliTransport(executable);
    if (cli.available()) return cli;
  }
  if (!tokens) {
    throw new Error(
      "No WorkIQ transport. Set WORKIQ_PATH for local use, or sign in for the service.",
    );
  }
  return new ServiceTransport(tokens, place);
}

export { CliTransport, ServiceTransport };
export type { Field, Picked, Place, Tokens, Transport };
