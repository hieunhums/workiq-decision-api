/**
 * Run the whole question corpus through the router and report what it got
 * right.
 *
 * This is the measurement the design rests on. It is what showed that Jev's
 * confidence does not separate correct routings from wrong ones, which is why
 * the fallback ladder triggers on an empty result instead of a low number.
 *
 * It routes only. Nothing is fetched, so it costs 102 Jev calls and no Work IQ
 * calls, and it can be run without being signed in to anything but Jev.
 *
 *   npm run route-check
 *   npm run route-check -- Manager "Search mail"    # only these topics
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("tsx/cjs");

const { Jev } = require("../src/lib/jev.ts");
const { plan } = require("../src/lib/router.ts");

for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const at = line.indexOf("=");
  if (at > 0 && !line.startsWith("#")) process.env[line.slice(0, at).trim()] ??= line.slice(at + 1).trim();
}

const corpus = JSON.parse(
  readFileSync(new URL("../src/lib/questions.json", import.meta.url), "utf8"),
);

const only = process.argv.slice(2);
const topics = only.length ? corpus.filter((t) => only.includes(t.topic)) : corpus;

const jev = new Jev(process.env.TYPESAFE_API_KEY ?? "");
const rows = [];

for (const topic of topics) {
  for (const question of topic.questions) {
    let got, confidence, failure, depth;
    try {
      const routed = await plan(jev, question);
      depth = routed.depth;
      // The target is a record id for a record, a source for a search, and
      // nothing at all for a question that has to be composed.
      got =
        routed.depth === "record"
          ? routed.record
          : routed.depth === "search"
            ? routed.scope
            : null;
      confidence = routed.reachCertainty?.confidence ?? 0;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    const right = !failure && depth === topic.depth && got === topic.target;
    rows.push({
      topic: topic.topic,
      question,
      want: `${topic.depth}${topic.target ? ` ${topic.target}` : ""}`,
      // Naming the depth as well as the target matters. A search with no
      // scope and a composed answer both have no target, and reporting only
      // the target makes a real miss read as a match.
      got: failure ? "failed" : `${depth}${got ? ` ${got}` : ""}`,
      right,
      confidence,
      failure,
    });
    process.stdout.write(right ? "." : failure ? "!" : "x");
  }
}

console.log("\n");

const wrong = rows.filter((r) => !r.right);
if (wrong.length) {
  console.log("Missed:");
  for (const r of wrong) {
    const detail = r.failure ?? `wanted ${r.want}, got ${r.got}`;
    console.log(`  ${r.question}\n    ${detail}  (${(r.confidence * 100).toFixed(0)}% sure)`);
  }
  console.log("");
}

const right = rows.filter((r) => r.right);
const mean = (list) =>
  list.length ? list.reduce((sum, r) => sum + r.confidence, 0) / list.length : 0;
const low = (list) => (list.length ? Math.min(...list.map((r) => r.confidence)) : 0);
const high = (list) => (list.length ? Math.max(...list.map((r) => r.confidence)) : 0);

console.log(`${right.length}/${rows.length} routed correctly`);
console.log("");
console.log("Confidence, which is the thing worth watching here:");
console.log(
  `  correct   mean ${mean(right).toFixed(2)}  lowest ${low(right).toFixed(2)}  highest ${high(right).toFixed(2)}`,
);
console.log(
  `  wrong     mean ${mean(wrong).toFixed(2)}  lowest ${low(wrong).toFixed(2)}  highest ${high(wrong).toFixed(2)}`,
);
console.log("");
console.log(
  low(right) < high(wrong)
    ? `  The ranges overlap: a correct routing came back less sure (${low(right).toFixed(2)}) than\n  a wrong one (${high(wrong).toFixed(2)}). No threshold separates them, which is why the\n  fallback triggers on an empty result instead.`
    : `  The ranges do not overlap in this run. Check again on a larger sample\n  before trusting a threshold.`,
);

process.exit(wrong.length > rows.length * 0.2 ? 1 : 0);
