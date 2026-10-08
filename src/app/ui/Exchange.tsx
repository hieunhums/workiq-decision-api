"use client";

import { useState } from "react";
import Markdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { Lookup, Rival, Turn } from "@/lib/useRealtime";
import type { Field } from "@/lib/workiq/records";
import type { WebSource } from "@/lib/webiq";
import { Path } from "./Path";
import { Elapsed } from "./measure";
import styles from "./ui.module.css";

/** One question and everything done to answer it. */
export type Exchange = {
  id: string;
  question: Turn | null;
  replies: Turn[];
  lookups: Lookup[];
  at: number;
};

/**
 * Folds the transcript and the lookups into one card per question, newest
 * first. They were two lists before, and matching a lookup to the sentence
 * that caused it was left to the reader.
 */
export function group(turns: Turn[], lookups: Lookup[]): Exchange[] {
  const byId = new Map<string, Exchange>();
  const get = (id: string, at: number) => {
    let found = byId.get(id);
    if (!found) {
      found = { id, question: null, replies: [], lookups: [], at };
      byId.set(id, found);
    }
    return found;
  };
  for (const turn of turns) {
    const exchange = get(turn.exchange, turn.at);
    if (turn.who === "you") {
      exchange.question = turn;
      exchange.at = turn.at;
    } else {
      exchange.replies.push(turn);
    }
  }
  for (const lookup of lookups) get(lookup.exchange, lookup.at).lookups.push(lookup);
  // A turn with no words is a sound the voice detector took for speech. It
  // still interrupts, and the model's reply to it is carrying on with the
  // last real question, so it is folded into that one rather than shown.
  const kept: Exchange[] = [];
  for (const exchange of [...byId.values()].sort((a, b) => a.at - b.at)) {
    const unheard = exchange.question?.done && !exchange.question.text;
    const previous = kept[kept.length - 1];
    if (unheard && previous) {
      previous.replies = [...previous.replies, ...exchange.replies].sort((a, b) => a.at - b.at);
      previous.lookups = [...previous.lookups, ...exchange.lookups];
      continue;
    }
    if (unheard && !exchange.replies.length && !exchange.lookups.length) continue;
    kept.push(exchange);
  }
  return kept.reverse();
}

/** The lane colour a lookup is drawn in. */
export function depthOf(lookup: Lookup): string {
  if (lookup.kind === "web") return "web";
  // Ask mode is Work IQ's composed ask, the same reach as Jev's slowest lane.
  if (lookup.engine === "direct") return "reasoned";
  if (lookup.engine === "picks") return "picks";
  return (lookup.routing ?? lookup.trace?.routing)?.depth ?? "unknown";
}

type Routing = NonNullable<Lookup["trace"]>["routing"];

export function describe(
  routing: Pick<Routing, "depth" | "record" | "scope"> & { parts?: Routing["parts"] },
): string {
  if (routing.parts?.length) return routing.parts.map((p) => describe(p)).join(", then ");
  if (routing.depth === "record") return `Read ${routing.record}`;
  if (routing.depth === "reasoned") return "Composed an answer";
  return routing.scope ? `Searched ${routing.scope}` : "Searched everywhere";
}

export function ExchangeCard({
  exchange,
  live,
  onOpen,
}: {
  exchange: Exchange;
  live: boolean;
  onOpen: (lookupId: string) => void;
}) {
  const { question, replies, lookups } = exchange;
  const first = lookups[0];

  // Whatever was said before the first lookup started is the "let me check"
  // line. Only what came after it is the answer to show large.
  const preamble = first ? replies.filter((r) => r.at < first.at) : [];
  const answer = first ? replies.filter((r) => r.at >= first.at) : replies;
  // A written reply is joined on blank lines so its paragraphs survive.
  const written = answer.some((r) => r.written);
  const answerText = answer
    .map((r) => r.text)
    .join(written ? "\n\n" : " ")
    .trim();
  const answering = answer.some((r) => !r.done);
  const waiting =
    live && !answerText && (lookups.some((l) => l.status === "running") || lookups.length > 0);
  const settled = lookups.find(
    (l) => l.kind === "web" || l.routing || l.trace || (l.engine && l.engine !== "jev"),
  );
  const depth = settled ? depthOf(settled) : "none";

  return (
    <article className={styles.exchange} data-depth={depth}>
      {question && (
        <h2
          className={styles.question}
          data-pending={!question.done}
          data-via={question.written ? "typed" : "spoken"}
        >
          {question.text ||
            (question.done ? (
              <span className={styles.unheard}>Could not make that out</span>
            ) : (
              <Transcribing />
            ))}
        </h2>
      )}

      {lookups.length > 0 && (
        <div className={styles.receipts}>
          {lookups.map((lookup) => (
            <Receipt key={lookup.id} lookup={lookup} onOpen={() => onOpen(lookup.id)} />
          ))}
          {lookups.map((lookup) => (
            <Path key={lookup.id} lookup={lookup} />
          ))}
        </div>
      )}

      {preamble.length > 0 && (
        <p className={styles.preamble}>{preamble.map((r) => r.text).join(" ")}</p>
      )}

      {answerText && written ? (
        <div className={`${styles.reply} ${styles.written}`} data-live={answering}>
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ href, children }) => (
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
              ),
            }}
          >
            {answerText}
          </Markdown>
        </div>
      ) : answerText ? (
        <p className={styles.reply} data-live={answering}>
          {answerText}
        </p>
      ) : (
        waiting && <Skeleton />
      )}

      {lookups.map((lookup) =>
        lookup.kind === "web" ? (
          lookup.sources?.length ? <Sources key={lookup.id} sources={lookup.sources} /> : null
        ) : lookup.records?.length ? (
          <Records key={lookup.id} records={lookup.records} />
        ) : lookup.text && lookup.found !== false ? (
          <Evidence key={lookup.id} text={lookup.text} depth={lookup.trace?.routing.depth} />
        ) : null,
      )}
    </article>
  );
}

function Transcribing() {
  return (
    <span className={styles.transcribing}>
      <i />
      <i />
      <i />
    </span>
  );
}

function Skeleton() {
  return (
    <div className={styles.skeleton} aria-label="Waiting for the answer">
      <span />
      <span />
    </div>
  );
}

/**
 * What the question cost, in one line: which lane, what was read, how long.
 * Clicking it opens the reasoning, the timeline and the comparison.
 */
function Receipt({ lookup, onOpen }: { lookup: Lookup; onOpen: () => void }) {
  const routing = lookup.routing ?? lookup.trace?.routing;
  const depth = depthOf(lookup);
  const web = lookup.kind === "web";
  const straight = !web && lookup.engine && lookup.engine !== "jev" ? lookup.engine : null;
  const calls = lookup.steps?.length ?? 0;
  return (
    <button
      className={styles.receipt}
      data-depth={depth}
      data-status={lookup.status}
      onClick={onOpen}
      title="How this was answered"
    >
      <span className={styles.receiptDot} />
      <span className={styles.receiptWhat}>
        {straight
          ? lookup.status === "running"
            ? straight === "picks"
              ? "The model is picking Work IQ calls"
              : "Work IQ is composing"
            : lookup.status === "failed"
              ? "Lookup failed"
              : straight === "picks"
                ? `The model made ${calls} Work IQ call${calls === 1 ? "" : "s"}`
                : "Work IQ composed it"
          : lookup.status === "running"
          ? web
            ? "Searching the web"
            : routing
              ? `${describe(routing)}\u2026`
              : "Jev is choosing"
          : lookup.status === "failed"
            ? web
              ? "Web search failed"
              : "Lookup failed"
            : web
              ? "Searched the web"
              : routing
              ? describe(routing)
              : "Looked it up"}
      </span>
      {routing?.forced && <span className={styles.receiptTag}>forced</span>}
      {lookup.found === false && <span className={styles.receiptTag}>nothing found</span>}
      <span className={styles.receiptTime}>
        {lookup.status === "running" ? (
          <Elapsed since={lookup.at} />
        ) : (
          `${lookup.seconds?.toFixed(1)}s`
        )}
      </span>
      <Faster lookup={lookup} />
      <span className={styles.receiptMore}>Details</span>
    </button>
  );
}

/** The comparison's result, once there is one, carried up onto the card. */
function Faster({ lookup }: { lookup: Lookup }) {
  const done = Object.values(lookup.rivals ?? {}).filter(
    (r): r is Rival & { seconds: number } => r?.status === "done" && r.seconds !== undefined,
  );
  if (!done.length || !lookup.seconds) return null;
  const nearest = Math.min(...done.map((r) => r.seconds));
  if (nearest - lookup.seconds <= 0.2) return null;
  return (
    <span className={styles.receiptFaster}>
      {(nearest / Math.max(lookup.seconds, 0.01)).toFixed(1)}x faster
    </span>
  );
}

/**
 * Fetched records as rows a person can scan: what it is in bold, when and who
 * underneath, a line or two of what it says. One record, such as a profile or
 * a manager, reads better as a small sheet of labelled values.
 */
function Records({ records }: { records: Field[][] }) {
  const [all, setAll] = useState(false);
  if (records.length === 1) return <Sheet fields={records[0]} />;

  const shown = all ? records : records.slice(0, 4);
  return (
    <div className={styles.records}>
      {shown.map((fields, index) => (
        <Row key={index} fields={fields} />
      ))}
      {records.length > 4 && (
        <button className={styles.more} onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `${records.length - 4} more`}
        </button>
      )}
    </div>
  );
}

function Row({ fields }: { fields: Field[] }) {
  const title = fields.find((f) => f.role === "title") ?? fields[0];
  const when = fields.filter((f) => f !== title && f.role === "when").map((f) => f.value);
  const who = fields.filter((f) => f !== title && f.role === "who").map((f) => person(f.value));
  const body = fields.find((f) => f !== title && f.role === "body");
  const meta = [span(when), ...who].filter(Boolean);
  return (
    <div className={styles.record}>
      <p className={styles.recordTitle}>{title?.value}</p>
      {meta.length > 0 && <p className={styles.recordMeta}>{meta.join("  \u00b7  ")}</p>}
      {body && <p className={styles.recordBody}>{tidy(body.value)}</p>}
    </div>
  );
}

/**
 * A start and an end on the same day read as one range. The dates arrive
 * already written out for the user's time zone, "Oct 1, 2026, 9:30 AM", so the
 * day is everything before the last comma.
 */
function span(when: string[]): string {
  if (when.length !== 2) return when.join(" to ");
  const [from, to] = when;
  const day = (value: string) => value.slice(0, value.lastIndexOf(","));
  if (day(from) && day(from) === day(to)) return `${from} to ${to.slice(day(to).length + 2)}`;
  return `${from} to ${to}`;
}

/** "Name, address" becomes the name. The address is noise at a glance. */
function person(value: string): string {
  const parts = value.split(", ").filter((part) => !part.includes("@"));
  return parts.join(", ") || value;
}

/** Meeting invites open with a rule of underscores. It is layout, not content. */
function tidy(value: string): string {
  return value.replace(/_{4,}/g, " ").replace(/\s+/g, " ").trim();
}

function Sheet({ fields }: { fields: Field[] }) {
  const title = fields.find((f) => f.role === "title");
  const rest = fields.filter((f) => f !== title);
  return (
    <div className={styles.sheet}>
      {title && <p className={styles.recordTitle}>{title.value}</p>}
      <dl className={styles.sheetGrid}>
        {rest.slice(0, 10).map((f) => (
          <div key={f.label} className={styles.sheetRow} data-role={f.role}>
            <dt>{f.label}</dt>
            <dd>{f.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * What a search or a composed answer brought back, folded away. The spoken
 * reply already says what matters in it; this is for checking the source.
 * Rendered as markdown without raw HTML, since it is untrusted text.
 */
function Evidence({ text, depth }: { text: string; depth?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.evidence} data-open={open}>
      <button className={styles.evidenceToggle} onClick={() => setOpen(!open)}>
        <span className={styles.caret} data-open={open}>
          {"\u203A"}
        </span>
        {depth === "reasoned" ? "What Work IQ wrote" : "What the search returned"}
      </button>
      {open && (
        <div className={styles.markdown}>
          <Markdown remarkPlugins={[remarkGfm, remarkBreaks]}>{text}</Markdown>
        </div>
      )}
    </div>
  );
}

/**
 * What the web search read, as links. A quote or a forecast leads, since that
 * is usually the answer itself; pages follow, three at a time.
 */
function Sources({ sources }: { sources: WebSource[] }) {
  const [all, setAll] = useState(false);
  const images = sources.filter((s) => s.kind === "image");
  const videos = sources.filter((s) => s.kind === "video");
  const facts = sources.filter((s) => s.kind === "weather" || s.kind === "finance");
  const pages = sources.filter((s) => s.kind === "web" || s.kind === "news");
  const shown = all ? pages : pages.slice(0, 3);
  return (
    <div className={styles.sources}>
      {images.length > 0 && <Gallery images={images} />}
      {videos.map((s) => (
        <Video key={s.url} video={s} />
      ))}
      {facts.map((s) => (
        <div key={s.url + s.kind} className={styles.fact}>
          <p className={styles.recordTitle}>{s.title}</p>
          <p className={styles.recordBody}>{s.snippet}</p>
          {s.date && <p className={styles.recordMeta}>As of {when(s.date)}</p>}
        </div>
      ))}
      {shown.map((s) => (
        <a
          key={s.url}
          className={styles.source}
          href={s.url}
          target="_blank"
          rel="noopener noreferrer nofollow"
        >
          <p className={styles.sourceSite}>
            {site(s.url)}
            {s.kind === "news" && <span className={styles.receiptTag}>news</span>}
            {s.date && <span>{"  \u00b7  "}{when(s.date)}</span>}
          </p>
          <p className={styles.recordTitle}>{s.title}</p>
          {s.snippet && <p className={styles.recordBody}>{s.snippet}</p>}
        </a>
      ))}
      {pages.length > 3 && (
        <button className={styles.more} onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `${pages.length - 3} more`}
        </button>
      )}
    </div>
  );
}

/** Previews in a grid; each opens the page it came from. */
function Gallery({ images }: { images: WebSource[] }) {
  return (
    <div className={styles.gallery}>
      {images.map((s) => (
        <a
          key={s.url + s.thumbnail}
          className={styles.picture}
          href={s.url}
          target="_blank"
          rel="noopener noreferrer nofollow"
          title={s.snippet || s.title}
          style={
            s.width && s.height
              ? ({ "--ratio": `${s.width} / ${s.height}` } as React.CSSProperties)
              : undefined
          }
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- remote Bing preview, not an app asset */}
          <img src={s.thumbnail} alt={s.snippet || s.title} loading="lazy" referrerPolicy="no-referrer" />
          <span className={styles.pictureSite}>{site(s.url)}</span>
        </a>
      ))}
    </div>
  );
}

/**
 * A video as its preview until pressed, then the player itself. Only players
 * Web IQ says allow embedding are loaded inline; the rest open on their site.
 */
function Video({ video }: { video: WebSource }) {
  const [playing, setPlaying] = useState(false);
  const meta = [
    video.publisher,
    video.views ? `${compact(video.views)} views` : "",
    video.date ? when(video.date) : "",
  ].filter(Boolean);
  const player = playing && video.embed ? (
    <iframe
      className={styles.player}
      src={`${video.embed}${video.embed.includes("?") ? "&" : "?"}autoplay=1`}
      title={video.title}
      allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
      referrerPolicy="strict-origin-when-cross-origin"
      allowFullScreen
    />
  ) : null;
  const preview = (
    <span className={styles.poster}>
      {video.thumbnail && (
        // eslint-disable-next-line @next/next/no-img-element -- remote Bing preview, not an app asset
        <img src={video.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" />
      )}
      <span className={styles.play} aria-hidden>
        {"\u25B6"}
      </span>
      {video.length && <span className={styles.length}>{video.length}</span>}
    </span>
  );
  return (
    <div className={styles.video} data-playing={Boolean(player)}>
      {player ??
        (video.embed ? (
          <button className={styles.posterButton} onClick={() => setPlaying(true)} aria-label={`Play ${video.title}`}>
            {preview}
          </button>
        ) : (
          <a href={video.url} target="_blank" rel="noopener noreferrer nofollow" aria-label={`Open ${video.title}`}>
            {preview}
          </a>
        ))}
      <div className={styles.videoText}>
        <a href={video.url} target="_blank" rel="noopener noreferrer nofollow" className={styles.recordTitle}>
          {video.title}
        </a>
        {meta.length > 0 && <p className={styles.recordMeta}>{meta.join("  \u00b7  ")}</p>}
        {!video.embed && <p className={styles.recordMeta}>Opens on {site(video.url)}</p>}
      </div>
    </div>
  );
}

function compact(n: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact" }).format(n);
}

function site(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Dates as a person reads them. Web IQ sends ISO, some without a zone. */
function when(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
