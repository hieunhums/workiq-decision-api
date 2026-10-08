/**
 * Turning a WorkIQ reply into text a person can read and a voice can speak.
 *
 * A reply is untrusted data. It can carry text an outside party wrote in mail
 * or chat. It may only be shown and spoken, or handed to the model as a tool
 * result. It must never reach instructions, choice descriptions or observed
 * state.
 */

/** Enough of a message to answer a question about it, while leaving room for the rest. */
const BODY_LIMIT = 600;

/** Identifiers address a record, they do not describe it. */
function isIdentifier(key: string): boolean {
  const k = key.toLowerCase();
  return (
    k === "id" ||
    k.endsWith("id") ||
    k.endsWith("ids") ||
    k === "changekey" ||
    k === "etag" ||
    k === "odatatype"
  );
}

/** An address is for a machine to follow. It crowds out the name of the thing it points at. */
function isAddress(key: string): boolean {
  const k = key.toLowerCase();
  return k.endsWith("url") || k.endsWith("uri") || k.endsWith("link") || k.includes("thumbnail");
}

/**
 * Inside a nested value, a field naming the kind of some aspect repeats what
 * the surrounding line already says. A sender read as "Megan Bowen, aadUser".
 */
function isKind(key: string): boolean {
  const k = key.toLowerCase();
  return k !== "type" && k.endsWith("type");
}

/** What someone wrote is the answer, not a detail beside it. */
function isBody(key: string): boolean {
  const k = key.toLowerCase();
  return (
    k === "body" || k === "content" || k.endsWith("preview") ||
    k.endsWith("body") || k.endsWith("content")
  );
}

/** What a person reads first: what it is called, then when, then who, then the rest. */
function rank(key: string): number {
  switch (key.toLowerCase()) {
    case "subject": case "displayname": case "name":
    case "title": case "topic": case "resourcevisualization":
      return 0;
    case "start": case "receiveddatetime": case "createddatetime": case "senddatetime":
      return 1;
    case "end": case "duedatetime": case "lastmodifieddatetime":
      return 2;
    case "from": case "sender": case "organizer": case "owner": case "author":
      return 3;
    default:
      return 4;
  }
}

function byRank(a: string, b: string): number {
  return rank(a) === rank(b) ? a.localeCompare(b) : rank(a) - rank(b);
}

/** An unset time arrives as year one. Formatted it reads as a real ancient date. */
function isUnsetStamp(text: string): boolean {
  return text.startsWith("0001-01-01");
}

/**
 * Graph timestamps arrive as ISO text. A person wants a date and a time.
 *
 * The zone matters more here than it looks. Graph returns UTC, and a meeting
 * at 01:30 UTC read back as "1:30 AM" to someone in Singapore, where it is
 * half past nine in the morning. Spoken aloud that is not a formatting
 * nuisance, it is the wrong answer.
 */
function stamp(text: string): string | null {
  if (text.length < 19 || !text.includes("T")) return null;
  const parsed = new Date(text.endsWith("Z") ? text : `${text}Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: process.env.USER_TIME_ZONE || "UTC",
  });
}

/** A chat message arrives as markup. The tags are not words anyone wrote. */
function plainHTML(html: string): string {
  let text = html
    // A block ending is a line break. Without this, sentences in separate
    // paragraphs run together into one word.
    .replace(/<(br|\/p|\/div|\/li|\/tr)[^>]*>/gi, "\n")
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]+>/g, "");
  // Entities are decoded after tags are gone, so text that mentions a tag by
  // writing &lt;p&gt; is not mistaken for markup and removed.
  const entities: [string, string][] = [
    ["&nbsp;", " "], ["&lt;", "<"], ["&gt;", ">"], ["&quot;", '"'],
    ["&#39;", "'"], ["&apos;", "'"], ["&amp;", "&"],
  ];
  for (const [entity, character] of entities) text = text.replaceAll(entity, character);
  return text.replace(/[ \t]{2,}/g, " ").trim();
}

/** A nested value shares one line. A whole document does not fit on it. */
function brief(text: string, limit = 120): string {
  const flat = text.split(/\r?\n/).join(" ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function readable(value: unknown): string | null {
  if (typeof value === "string") {
    if (!value || isUnsetStamp(value)) return null;
    return stamp(value) ?? value;
  }
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(readable).filter((p): p is string => Boolean(p));
    return parts.length ? parts.join(", ") : null;
  }
  if (value && typeof value === "object") {
    const nested = value as Record<string, unknown>;
    // A Graph time arrives as a stamp beside its zone. Reading the zone as a
    // second value put "UTC" on the end of every date.
    if (typeof nested.dateTime === "string") return readable(nested.dateTime);
    // Graph carries a body as content beside the name of its markup. The
    // markup name is not part of what was said.
    if (typeof nested.content === "string" && nested.contentType !== undefined) {
      const text = plainHTML(nested.content);
      return text || null;
    }
    const keys = Object.keys(nested)
      .filter((k) => !k.includes("@") && !isIdentifier(k) && !isAddress(k) && !isKind(k))
      .sort(byRank);
    const parts = keys
      .map((key) => {
        // A flag that is off is not news.
        if (nested[key] === false) return null;
        const line = readable(nested[key]);
        return line === null ? null : brief(line, isBody(key) ? BODY_LIMIT : 120);
      })
      .filter((p): p is string => Boolean(p));
    return parts.length ? parts.join(", ") : null;
  }
  return null;
}

/** Field names arrive as one word. Separate them so they read aloud. */
function spaced(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

/**
 * One field of a fetched record, ready to lay out. `role` says how a person
 * reads it: the name first, then when and who, then what was written, then
 * the rest. The page uses it to set type, not to decide anything.
 */
export type Field = {
  label: string;
  value: string;
  role: "title" | "when" | "who" | "body" | "detail";
};

function roleOf(key: string): Field["role"] {
  if (isBody(key)) return "body";
  const r = rank(key);
  if (r === 0) return "title";
  if (r === 1 || r === 2) return "when";
  if (r === 3) return "who";
  return "detail";
}

/** A fetched record as ordered fields, identifiers and addresses dropped. */
function fields(record: Record<string, unknown>): Field[] {
  return Object.keys(record)
    .filter((k) => !k.includes("@") && !isIdentifier(k))
    .sort(byRank)
    .map((key): Field | null => {
      const value = readable(record[key]);
      return value ? { label: spaced(key), value, role: roleOf(key) } : null;
    })
    .filter((f): f is Field => f !== null);
}

/** A fetched record is a field map. Read it back as lines rather than as JSON. */
function describe(record: Record<string, unknown>): string {
  return fields(record)
    .map((f) => `${f.label}: ${f.value}`)
    .join("\n");
}

/**
 * The same fetched records as fields, for the page to lay out as rows rather
 * than as a block of text. Null when the reply is not a record read.
 */
export function structured(result: Record<string, unknown>): Field[][] | null {
  return records(result)?.map(fields).filter((f) => f.length > 0) ?? null;
}

/**
 * The fetched records in a reply, a collection's `value` list read as one
 * record per member. Null when the reply is not a record read.
 */
function records(result: Record<string, unknown>): Record<string, unknown>[] | null {
  const shaped = result.structuredContent as Record<string, unknown> | undefined;
  if (!shaped || !Array.isArray(shaped.results)) return null;
  return (shaped.results as Record<string, unknown>[])
    .map((r) => r.data as Record<string, unknown> | undefined)
    .filter((d): d is Record<string, unknown> => Boolean(d))
    .flatMap((record) =>
      Array.isArray(record.value) && record.value.length
        ? (record.value as Record<string, unknown>[])
        : [record],
    );
}

/**
 * Several records read as one block with no sense of how many there are. A
 * count answers "do I have any" before a single line is read.
 */
function numbered(records: string[]): string {
  if (records.length <= 1) return records[0] ?? "";
  const lines = records.map(
    (record, index) => `${index + 1}. ${record.split("\n").join("\n   ")}`,
  );
  return `${records.length} records.\n\n${lines.join("\n\n")}`;
}

/** The client can repeat the whole answer in one field. Collapse only an exact doubling. */
function collapseDuplicate(text: string): string {
  if (text.length < 2 || text.length % 2 !== 0) return text;
  const half = text.length / 2;
  return text.slice(0, half) === text.slice(half) ? text.slice(0, half) : text;
}

/** Spoken replies take plain text. Markdown syntax and citation links are presentation. */
function plainText(markdown: string): string {
  return markdown
    .replace(/\[\^[^\]]*\]/g, "")
    .replace(/\[\d+\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/\*\*|__|`/g, "")
    // A run of spaces at the start of a line is the indent that keeps a
    // numbered record readable. Collapse only what follows visible text.
    .replace(/(\S)[ \t]{2,}/g, "$1 ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Keep a readable amount and say what was left out rather than silently cutting. */
export function capped(text: string, limit = 4000): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n… ${text.length - limit} more characters.`;
}

/**
 * The aggregate count a retrieval reports. A search that found nothing is not
 * a fact about the workplace, it is a failed attempt to look, and the two must
 * not be reported the same way.
 */
export function resultCount(raw: string): number | null {
  const match = /Result Count:\s*\**\s*(\d+)/.exec(raw);
  return match ? Number(match[1]) : null;
}

/**
 * Replies arrive as text content, as a typed retrieval document, or as fetched
 * records. Accept each shape rather than assuming one.
 */
export function content(result: Record<string, unknown>): string | null {
  const structured = result.structuredContent as Record<string, unknown> | undefined;
  if (structured) {
    for (const value of Object.values(structured)) {
      const document = value as Record<string, unknown> | null;
      if (document && typeof document === "object" && typeof document.markdown === "string") {
        if (document.markdown) return document.markdown;
      }
    }
    const read = records(result);
    if (read) {
      const described = read.map(describe).filter(Boolean);
      if (described.length) return numbered(described);
      // The read succeeded and held nothing. Say so rather than reporting an
      // empty reply as a failure.
      return "No records.";
    }
  }
  if (Array.isArray(result.content)) {
    const text = (result.content as Record<string, unknown>[])
      .map((item) => (typeof item.text === "string" ? item.text : ""))
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }
  return null;
}

/** The whole cleanup, applied in the order that keeps each step meaningful. */
export function readableReply(raw: string): string {
  return capped(plainText(collapseDuplicate(raw)));
}
