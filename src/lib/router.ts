import { Jev, type Certainty, type Judgments, type Question, yesNo } from "./jev";
import { meaning } from "./prompts";

/**
 * How much work the service should do. Cost rises with each step, so ask for
 * the cheapest one that can answer.
 */
export type Depth = "record" | "search" | "reasoned";

export const DEPTHS: Depth[] = ["record", "search", "reasoned"];

/** Measured on this stack. Shown so the cost of each step is visible. */
export const EXPECTED: Record<Depth, string> = {
  record: "about 1s",
  search: "about 10s",
  reasoned: "30 to 60s",
};

export const TOOL_FOR: Record<Depth, string> = {
  record: "fetch",
  search: "retrieve",
  reasoned: "ask",
};

/**
 * The sources a search can be confined to. Searching every source costs about
 * eleven seconds; naming one narrows both the index walked and the results
 * ranked.
 *
 * Dataverse and Graph connectors are deliberately absent: the service rejects
 * them alongside the grounding strategy used here.
 */
export const SCOPES = [
  { id: "people", wire: "People" },
  { id: "meetings", wire: "Meetings" },
  { id: "files", wire: "OneDriveAndSharePoint" },
  { id: "email", wire: "Email" },
  { id: "teams", wire: "TeamsMessages" },
] as const;

type ScopeId = (typeof SCOPES)[number]["id"];

/**
 * The records a question can be answered from directly.
 *
 * Every path names the fields it needs and caps the rows it wants. The service
 * returns whole entities otherwise: the mail list alone came back as five
 * megabytes in nine seconds, and as three kilobytes in one second once asked
 * for four fields and ten rows.
 *
 * `{now}` is replaced with the current time when the read is made. A calendar
 * read without it returned meetings from 2017, which answers nothing.
 */
export const RECORDS: {
  id: string;
  path: string;
  /**
   * The source this record is a recent window of, where there is one. A
   * question naming one particular thing in it is searched there instead.
   */
  slice?: ScopeId;
}[] = [
  {
    id: "me",
    path: "/me?$select=displayName,jobTitle,department,officeLocation,mail",
  },
  {
    id: "manager",
    path: "/me/manager?$select=displayName,jobTitle,department,officeLocation,mail",
  },
  {
    id: "directReports",
    path: "/me/directReports?$select=displayName,jobTitle,department,mail",
  },
  {
    id: "people",
    path: "/me/people?$select=displayName,jobTitle,department,userPrincipalName&$top=15",
    slice: "people",
  },
  // bodyPreview is what makes these answerable. Subject, sender and date say a
  // message arrived; they do not say what it wants.
  {
    id: "events",
    path:
      "/me/events?$select=subject,start,end,organizer,location,bodyPreview" +
      "&$filter=start/dateTime%20ge%20'{now}'&$orderby=start/dateTime&$top=15",
    slice: "meetings",
  },
  {
    id: "messages",
    path:
      "/me/messages?$select=subject,from,receivedDateTime,bodyPreview" +
      "&$orderby=receivedDateTime%20desc&$top=15",
    slice: "email",
  },
  {
    id: "unread",
    path:
      "/me/mailFolders/inbox/messages?$select=subject,from,receivedDateTime,bodyPreview" +
      "&$filter=isRead%20eq%20false&$orderby=receivedDateTime%20desc&$top=15",
    slice: "email",
  },
  // members expanded to 393 kilobytes on one meeting chat of 749 people and
  // still could not say what anyone said. lastMessagePreview costs about a
  // kilobyte and carries the newest message and its sender.
  {
    id: "chats",
    path:
      "/me/chats?$select=topic,chatType&$expand=lastMessagePreview" +
      "&$orderby=lastMessagePreview/createdDateTime%20desc&$top=15",
    slice: "teams",
  },
  // A one to one chat has no topic, so the only name on it is whoever sent the
  // last message. Filtering to one to one chats makes members affordable.
  {
    id: "direct",
    path:
      "/me/chats?$filter=chatType%20eq%20'oneOnOne'&$select=chatType" +
      "&$expand=members,lastMessagePreview" +
      "&$orderby=lastMessagePreview/createdDateTime%20desc&$top=20",
  },
  { id: "presence", path: "/me/presence" },
  {
    id: "tasks",
    path: "/me/planner/tasks?$select=title,dueDateTime,percentComplete,priority&$top=20",
  },
  { id: "files", path: "/me/insights/used?$top=10", slice: "files" },
  { id: "shared", path: "/me/insights/shared?$top=10", slice: "files" },
  { id: "teams", path: "/me/joinedTeams?$select=displayName,description" },
  {
    id: "groups",
    path: "/me/memberOf/graph.group?$select=displayName,description&$top=20",
  },
];

/**
 * A probability of yes is read as yes from one half up. These are
 * probabilities of one small question each, not the confidence of a choice,
 * which did not separate right from wrong over 102 questions.
 */
const YES = 0.5;

/** More sources named than this is read as naming none: all five cost the same as four. */
const MOST_SOURCES = 3;

/** How much of a result the check is shown. Enough for the leading results. */
const CHECKED_CHARACTERS = 6000;

type Part = { question: string; plan: Plan };

export type Plan = {
  depth: Depth;
  /** The record path to read, set only when the depth reads one record. */
  path: string | null;
  /** Which of the offered records was chosen, by name. */
  record: string | null;
  /** The sources a search is confined to. Empty means every source. */
  scopes: ScopeId[];
  /** The same sources joined for display, or null for every source. */
  scope: string | null;
  /** What the chosen record holds, in the words the choice was made from. */
  meaning: string | null;
  /** How sure Jev was of the reach. Shown, never used to decide. */
  reachCertainty: Certainty | null;
  /** The probability of yes for each planning check, by key. */
  checks: Record<string, number>;
  /**
   * A record Jev chose that was replaced by a search, because the question
   * named one particular thing the record holds only a recent window of.
   */
  narrowedFrom: string | null;
  /** The separate requests the question was cut into. Empty when it is one. */
  parts: Part[];
  seconds: number;
  /**
   * The depth a person insisted on, when they did. Jev still chose what to
   * read and where to search; only how far to reach was taken from it.
   */
  forced: Depth | null;
  /** Why a forced depth could not be honoured, when it could not. */
  overruled: string | null;
};

/** What a check of a retrieved result found. */
type Verdict = {
  /** The probability that the result holds what was asked for. */
  answered: number;
  /** The probability that it holds several candidates for the one item asked for. */
  ambiguous: number;
  /** Whether the result can be read as the answer. */
  holds: boolean;
  /** Why it cannot, when it cannot. */
  reason: string | null;
};

const REACH_KEY = "workplace_reach";
const RECORD_KEY = "workplace_path";
const COUNT_KEY = "workplace_count";
/** Whether a later request leans on a name from an earlier one, and so cannot stand alone. */
const REFERS_KEY = "workplace_refers_back";
const PARTICULAR_KEY = "workplace_particular";
const ANSWERED_KEY = "workplace_answered";
const AMBIGUOUS_KEY = "workplace_ambiguous";

/** The counts offered, as option and number of requests. */
const COUNTS = [
  { id: "one", requests: 1 },
  { id: "two", requests: 2 },
  { id: "three", requests: 3 },
  { id: "four", requests: 4 },
] as const;

const ORDINALS = ["first", "second", "third", "fourth"];

/** Requests are numbered from zero. */
function cutKey(request: number, ends: boolean): string {
  return `workplace_cut_${ends ? "end" : "start"}_${request}`;
}

/** Every cut a question of the most requests can need. */
const CUTS = Array.from({ length: COUNTS.length - 1 }, (_, i) => [
  { request: i, ends: true },
  { request: i + 1, ends: false },
]).flat();

export const sourceKey = (scope: ScopeId) => `workplace_source_${scope}`;

/** The yes or no questions asked beside the choices, each one small thing. */
const CHECKS = [...SCOPES.map((s) => sourceKey(s.id)), PARTICULAR_KEY];

export function questions(): Question[] {
  return [
    {
      key: REACH_KEY,
      instructions: meaning(REACH_KEY),
      options: DEPTHS.map((depth) => ({
        id: depth,
        description: meaning(`${REACH_KEY}_${depth}`),
      })),
      noneDescription: meaning(`${REACH_KEY}_none`),
    },
    {
      key: RECORD_KEY,
      instructions: meaning(RECORD_KEY),
      options: RECORDS.map((record) => ({
        id: record.id,
        description: meaning(`${RECORD_KEY}_${record.id}`),
      })),
      noneDescription: meaning(`${RECORD_KEY}_none`),
    },
    ...CHECKS.map((key) => yesNo(key, meaning(key))),
  ];
}

/** The count and every cut, asked over the question's own words. */
function cutQuestions(words: Word[]): Question[] {
  const positions = words.map((w, i) => ({ id: w.id, description: `Word ${i}: ${w.text}` }));
  return [
    {
      key: COUNT_KEY,
      instructions: meaning(COUNT_KEY),
      options: COUNTS.map((c) => ({ id: c.id, description: meaning(`${COUNT_KEY}_${c.id}`) })),
    },
    yesNo(REFERS_KEY, meaning(REFERS_KEY)),
    ...CUTS.map((cut) => ({
      key: cutKey(cut.request, cut.ends),
      instructions: meaning(cut.ends ? "workplace_cut_end" : "workplace_cut_start").replace(
        "{ordinal}",
        ORDINALS[cut.request],
      ),
      options: positions,
      noneDescription: meaning("workplace_cut_none"),
    })),
  ];
}

/** One word of a question and where it sits, so a cut lands on what was written. */
type Word = { id: string; text: string; start: number; end: number };

function words(text: string): Word[] {
  const found: Word[] = [];
  for (const piece of new Intl.Segmenter(undefined, { granularity: "word" }).segment(text)) {
    if (!piece.isWordLike) continue;
    found.push({
      id: `w${found.length}`,
      text: piece.segment,
      start: piece.index,
      end: piece.index + piece.segment.length,
    });
  }
  return found;
}

/**
 * The requests a question makes, cut where Jev said each one ends and the
 * next begins. Null when it makes one, or when the cuts do not run forward
 * through the question, which is read as no cut rather than guessed at.
 */
function pieces(text: string, list: Word[], judged: Judgments): string[] | null {
  const requests = COUNTS.find((c) => c.id === judged.by[COUNT_KEY]?.answer)?.requests ?? 1;
  if (requests < 2) return null;
  // "Is there a Teams thread on it" searched alone has lost what "it" was.
  if ((judged.likely[REFERS_KEY] ?? 0) >= YES) return null;
  const word = (request: number, ends: boolean) => {
    const id = judged.by[cutKey(request, ends)]?.answer;
    return list.find((w) => w.id === id) ?? null;
  };
  const found: string[] = [];
  let from = 0;
  for (let request = 0; request < requests - 1; request += 1) {
    const end = word(request, true);
    const next = word(request + 1, false);
    if (!end || !next || end.start < from || next.start < end.end) return null;
    found.push(text.slice(from, end.end));
    from = next.start;
  }
  found.push(text.slice(from));
  const trimmed = found.map((p) => p.trim());
  return trimmed.some((p) => !p) ? null : trimmed;
}

/** Where a plan reaches, in a form two plans can be compared by. */
function destination(plan: Plan): string {
  if (plan.parts.length) return plan.parts.map((p) => destination(p.plan)).join(" + ");
  if (plan.record) return `${plan.depth} ${plan.record}`;
  return plan.scope ? `${plan.depth} in ${plan.scope}` : plan.depth;
}

const COST: Record<Depth, number> = { record: 0, search: 1, reasoned: 2 };

function joined(scopes: ScopeId[]): string | null {
  return scopes.length ? scopes.join("+") : null;
}

/**
 * Chooses how far to reach for a workplace answer before any retrieval runs.
 *
 * Every question travels in one request, so a plan costs one round trip
 * however many there are. Each asks one small thing, and the plan is put
 * together from the answers here rather than by one broad choice, which
 * could only ever pick one of two things asked for.
 */
export async function plan(
  jev: Jev,
  question: string,
  forced: Depth | null = null,
  cutting = true,
): Promise<Plan> {
  const started = Date.now();
  const trimmed = question.trim();
  const empty: Plan = {
    depth: "search",
    path: null,
    record: null,
    scopes: [],
    scope: null,
    meaning: null,
    reachCertainty: null,
    checks: {},
    narrowedFrom: null,
    parts: [],
    seconds: 0,
    forced: forced ?? null,
    overruled: null,
  };
  if (!trimmed) return empty;

  // How many requests there are, and where each starts and ends, is asked at
  // the same time in its own request. Waiting for the count first would cost
  // a second round trip on every question, and the word list changed how the
  // reach was chosen when it shared the plan's state. A choice holds at most
  // 254 options, so a longer question is planned whole.
  const list = words(trimmed);
  const cuttable = cutting && list.length > 1 && list.length <= 254;
  const cuts = cuttable
    ? jev
        .judge(
          {
            workplace_question: trimmed,
            question_words: list.map((w) => ({ id: w.id, text: w.text })),
          },
          cutQuestions(list),
        )
        .catch(() => null)
    : Promise.resolve(null);
  // The question is the only state. No retrieved content is placed here, so a
  // reply can never influence a plan.
  const [judged, cut] = await Promise.all([
    jev.judge({ workplace_question: trimmed }, questions()),
    cuts,
  ]);
  const seconds = (Date.now() - started) / 1000;
  const checks = judged.likely;
  const said = (key: string) => (checks[key] ?? 0) >= YES;

  // A cut that could not be judged leaves the question whole.
  const split = cut ? pieces(trimmed, list, cut) : null;
  if (split) {
    const parts = await Promise.all(
      split.map(async (piece) => ({ question: piece, plan: await plan(jev, piece, forced, false) })),
    );
    // Requests that reach the same place are one request worded twice, such
    // as asking for reports and then for their titles.
    if (new Set(parts.map((p) => destination(p.plan))).size > 1) {
      const depth = parts
        .map((p) => p.plan.depth)
        .reduce((a, b) => (COST[b] > COST[a] ? b : a));
      return {
        ...empty,
        depth,
        checks,
        parts,
        seconds: (Date.now() - started) / 1000,
      };
    }
  }

  const reach = judged.by[REACH_KEY];
  const record = judged.by[RECORD_KEY];
  const chosen = (DEPTHS.find((d) => d === reach.answer) ?? "search") as Depth;
  const depth = forced ?? chosen;
  // Each source is asked about on its own, so a question naming meetings and
  // chats searches both. Asking whether the answer could be somewhere was yes
  // for almost every source, so what is asked is whether the question itself
  // points there.
  const named = SCOPES.map((s) => s.id).filter((id) => said(sourceKey(id)));
  const scopes = named.length > MOST_SOURCES ? [] : named;

  const base: Plan = {
    ...empty,
    depth,
    scopes,
    scope: joined(scopes),
    reachCertainty: reach.certainty,
    checks,
    seconds,
  };
  if (depth !== "record") return base;

  // A record was asked for but none of the offered records fits. Search rather
  // than read an unrelated record.
  const match = RECORDS.find((r) => r.id === record.answer);
  if (!match) {
    return {
      ...base,
      depth: "search",
      overruled: forced === "record" ? "No stored record fits this question, so it searched." : null,
    };
  }

  // A list holds the most recent few. Asked about one named meeting, sender
  // or file, it can only say whether that thing is among them, and "not among
  // them" was reported as "there is none". Searching the source the list is
  // drawn from finds it at any age.
  if (said(PARTICULAR_KEY) && match.slice && forced !== "record") {
    const widened = scopes.includes(match.slice) ? scopes : [match.slice, ...scopes];
    return {
      ...base,
      depth: "search",
      scopes: widened,
      scope: joined(widened),
      narrowedFrom: match.id,
    };
  }

  return {
    ...base,
    depth: "record",
    path: match.path,
    record: match.id,
    scopes: [],
    scope: null,
    meaning: meaning(`${RECORD_KEY}_${match.id}`),
  };
}

/** What a search over these sources returns. No sources means every one. */
function searchHolds(scopes: ScopeId[]): string {
  return (scopes.length ? scopes : SCOPES.map((s) => s.id))
    .map((id) => meaning(`workplace_holds_${id}`))
    .join(" ");
}

/**
 * Whether a cheap result holds what was asked, asked after it returns.
 *
 * This is the one place retrieved content enters Jev's state. The only thing
 * it can cause is a hand-off to a slower reach, never a different read, so
 * text inside a result cannot steer anything else.
 */
export async function check(
  jev: Jev,
  question: string,
  result: string,
  plan: Plan,
): Promise<Verdict> {
  // A result never says what it is. /me/people is names and titles with
  // nothing to show they are the people worked with most, and without its
  // meaning the check read it as not answering that. A meeting search holds
  // excerpts, not the conversation, and without being told the check passed
  // excerpts as a summary of the meeting.
  const source = plan.depth === "search" ? searchHolds(plan.scopes) : plan.meaning;
  const judged = await jev.judge(
    {
      workplace_question: question,
      result: result.slice(0, CHECKED_CHARACTERS),
      ...(source ? { result_source: source } : {}),
    },
    [ANSWERED_KEY, AMBIGUOUS_KEY].map((key) => yesNo(key, meaning(key))),
  );
  const answered = judged.likely[ANSWERED_KEY] ?? 0;
  const ambiguous = judged.likely[AMBIGUOUS_KEY] ?? 0;
  const particular = plan.checks[PARTICULAR_KEY] ?? 0;
  // Several candidates count against a result only when the question named
  // one thing, because a question asking for a list is answered by several.
  const doubtful = ambiguous >= YES && particular >= YES;
  const holds = answered >= YES && !doubtful;
  const reason = holds
    ? null
    : answered < YES
      ? `the result does not hold what was asked (${Math.round(answered * 100)}%)`
      : `the result holds several candidates for the one item asked for (${Math.round(ambiguous * 100)}%)`;
  return { answered, ambiguous, holds, reason };
}

/**
 * A record path is written once and read whenever it is asked for, so a path
 * that needs the current time cannot hold a fixed one.
 */
function resolve(path: string, at = new Date()): string {
  if (!path.includes("{now}")) return path;
  // Graph compares a naked date and time against the zone it is told, and
  // rejects the trailing marker in a filter literal.
  const stamp = at.toISOString().replace(/\.\d+Z$/, "");
  return path.replaceAll("{now}", stamp);
}

/** What the chosen plan sends to the service. */
export function args(plan: Plan, question: string): Record<string, unknown> {
  if (plan.depth === "record") {
    return { entityUrls: [resolve(plan.path ?? "")] };
  }
  if (plan.depth === "reasoned") return { question };
  const wires = SCOPES.filter((s) => plan.scopes.includes(s.id)).map((s) => ({ name: s.wire }));
  return wires.length
    ? { query: question, strategy: "grounding", capabilities: wires }
    : { query: question, strategy: "grounding" };
}
