"use client";

import type { Lookup } from "@/lib/useRealtime";
import { Elapsed, ms, share } from "./measure";
import styles from "./Path.module.css";

/**
 * The choices behind one lookup, drawn as they are made: the voice model
 * picking Work IQ or the web, Jev picking how far to reach, where it looked,
 * and the call that went out. A stage scans while its choice is open and
 * locks when the choice lands, so the order and the waiting are both visible.
 * Nothing here is staged for effect: each lock is driven by a real event.
 */
export function Path({ lookup }: { lookup: Lookup }) {
  const web = lookup.kind === "web";
  return (
    <div className={styles.path} data-status={lookup.status}>
      <Stage label={lookup.written ? "Text model" : "Voice model"} done>
        <Chip on={!web} off={web} depth="search" tag="Work IQ">
          ask_workplace
        </Chip>
        <Chip on={web} off={!web} depth="web" tag="Web IQ">
          search_web
        </Chip>
      </Stage>
      {web ? (
        <Web lookup={lookup} />
      ) : lookup.engine && lookup.engine !== "jev" ? (
        <Direct lookup={lookup} />
      ) : (
        <Workplace lookup={lookup} />
      )}
    </div>
  );
}

const REACHES = [
  { id: "record", name: "Record", cost: "~1s" },
  { id: "search", name: "Search", cost: "~10s" },
  { id: "reasoned", name: "Compose", cost: "~52s" },
] as const;

const TOOLS: Record<string, string> = { record: "fetch", search: "retrieve", reasoned: "ask" };

function Workplace({ lookup }: { lookup: Lookup }) {
  const routing = lookup.routing ?? lookup.trace?.routing;
  const failed = lookup.status === "failed";
  const deciding = !routing && !failed;
  const odds = routing?.reach?.ranked;
  const steps = lookup.trace?.steps ?? [];

  return (
    <>
      <Stage
        wire={{ busy: deciding }}
        label="Jev"
        note={routing ? (routing.forced ? "set by you" : `${ms(routing.seconds)}`) : "choosing"}
        done={!!routing}
      >
        {REACHES.map((reach, index) => {
          const chosen = routing?.depth === reach.id;
          return (
            <Chip
              key={reach.id}
              depth={reach.id}
              on={chosen}
              off={!!routing && !chosen}
              scan={deciding}
              delay={index}
              tag={reach.cost}
              share={routing && !routing.forced ? share(odds, reach.id) : undefined}
            >
              {reach.name}
            </Chip>
          );
        })}
      </Stage>

      {routing && (
        <>
          <Stage wire={{ busy: false }} label={routing.depth === "record" ? "Record" : "Where"} done>
            <Chip depth={routing.depth} on share={where(routing)}>
              {routing.parts?.length
                ? `${routing.parts.length} requests`
                : routing.depth === "record"
                ? routing.record
                : routing.depth === "reasoned"
                  ? "Work IQ writes it"
                  : routing.scope ?? "everywhere"}
            </Chip>
          </Stage>
          <Stage
            wire={{ busy: lookup.status === "running", depth: routing.depth }}
            label="Work IQ"
            note={
              lookup.status === "running" ? (
                <Elapsed since={lookup.routedAt ?? lookup.at} />
              ) : (
                lookup.seconds && `${lookup.seconds.toFixed(1)}s`
              )
            }
            done={lookup.status !== "running"}
          >
            {(steps.length ? steps : [{ tool: TOOLS[routing.depth], found: null, what: "" }]).map(
              (step, index) => (
                <Chip
                  key={index}
                  depth={routing.depth}
                  on={lookup.status === "done"}
                  scan={lookup.status === "running"}
                  tag={
                    lookup.status !== "done"
                      ? undefined
                      : step.found === null
                        ? "\u2713"
                        : `${step.found} found`
                  }
                  title={step.what}
                >
                  {step.tool}
                </Chip>
              ),
            )}
          </Stage>
        </>
      )}
      {failed && <span className={styles.failed}>failed</span>}
    </>
  );
}

/**
 * The two ways without Jev, picked on the page. Ask mode is one composed `ask`.
 * Picks is a model holding Work IQ's tools: its calls are only known once it
 * has made them, so they scan as one open choice until the answer lands.
 */
function Direct({ lookup }: { lookup: Lookup }) {
  const running = lookup.status === "running";
  const picks = lookup.engine === "picks";
  const depth = picks ? "picks" : "reasoned";
  const steps = lookup.steps ?? [];
  const took = running ? (
    <Elapsed since={lookup.at} />
  ) : (
    lookup.seconds && `${lookup.seconds.toFixed(1)}s`
  );
  return (
    <>
      <Stage
        wire={{ busy: running, depth }}
        label={picks ? "Model picks Work IQ calls" : "Work IQ, no routing"}
        note={
          picks && !running && lookup.modelSeconds !== undefined ? (
            <>
              {took} {"\u00b7"} {lookup.modelSeconds.toFixed(1)}s deciding
            </>
          ) : (
            took
          )
        }
        done={!running}
      >
        {picks ? (
          running ? (
            <Chip depth={depth} scan>
              choosing its calls
            </Chip>
          ) : steps.length ? (
            steps.map((step, index) => (
              <Chip
                key={index}
                depth={depth}
                on={!step.failed}
                off={step.failed}
                tag={`${step.seconds.toFixed(1)}s`}
                title={step.args}
              >
                {step.tool}
              </Chip>
            ))
          ) : (
            <Chip depth={depth} off>
              no calls
            </Chip>
          )
        ) : (
          <Chip depth={depth} on={lookup.status === "done"} scan={running} tag={running ? undefined : "\u2713"}>
            ask
          </Chip>
        )}
      </Stage>
      {lookup.status === "failed" && <span className={styles.failed}>failed</span>}
    </>
  );
}

const VERTICALS = [
  { id: "web", name: "Pages" },
  { id: "news", name: "News" },
  { id: "weather", name: "Weather" },
  { id: "finance", name: "Finance" },
  { id: "image", name: "Images" },
  { id: "video", name: "Videos" },
] as const;

/**
 * Web IQ's sonic call reads every vertical at once and returns what matched,
 * so they scan together and the ones that came back light up. Images and
 * videos are separate Web IQ calls, made alongside only when the model asks.
 */
function Web({ lookup }: { lookup: Lookup }) {
  const running = lookup.status === "running";
  const counts = new Map<string, number>();
  for (const source of lookup.sources ?? []) {
    counts.set(source.kind, (counts.get(source.kind) ?? 0) + 1);
  }
  return (
    <>
      <Stage
        wire={{ busy: running, depth: "web" }}
        label="Web IQ"
        note={running ? <Elapsed since={lookup.at} /> : lookup.seconds && `${lookup.seconds.toFixed(1)}s`}
        done={!running}
      >
        {VERTICALS.map((vertical, index) => {
          const count = counts.get(vertical.id) ?? 0;
          return (
            <Chip
              key={vertical.id}
              depth="web"
              on={!running && count > 0}
              off={!running && count === 0}
              scan={running}
              delay={index}
              tag={count ? String(count) : undefined}
            >
              {vertical.name}
            </Chip>
          );
        })}
      </Stage>
      {lookup.status === "failed" && <span className={styles.failed}>failed</span>}
    </>
  );
}

/**
 * One choice. `wire` draws the link in from the stage before, kept with this
 * stage so a wrapped row never ends on a loose connector.
 */
function Stage({
  label,
  note,
  done,
  wire,
  children,
}: {
  label: string;
  note?: React.ReactNode;
  done: boolean;
  wire?: { busy: boolean; depth?: string };
  children: React.ReactNode;
}) {
  return (
    <div className={styles.stage} data-done={done}>
      {wire && <Link busy={wire.busy} depth={wire.depth} />}
      <div className={styles.body}>
        <p className={styles.label}>
          {label}
          {note && <span className={styles.note}>{note}</span>}
        </p>
        <div className={styles.chips}>{children}</div>
      </div>
    </div>
  );
}

function Chip({
  children,
  depth,
  on = false,
  off = false,
  scan = false,
  delay = 0,
  tag,
  share,
  title,
}: {
  children: React.ReactNode;
  depth: string;
  on?: boolean;
  off?: boolean;
  scan?: boolean;
  delay?: number;
  tag?: string;
  share?: number;
  title?: string;
}) {
  return (
    <span
      className={styles.chip}
      data-depth={depth}
      data-on={on}
      data-off={off}
      data-scan={scan}
      style={{ "--i": delay } as React.CSSProperties}
      title={title}
    >
      {children}
      {tag && <em className={styles.tag}>{tag}</em>}
      {share !== undefined && (
        <span className={styles.share} style={{ "--p": share } as React.CSSProperties}>
          {Math.round(share * 100)}%
        </span>
      )}
    </span>
  );
}

/** The wire between stages. It runs while the next stage is being waited on. */
function Link({ busy, depth = "none" }: { busy: boolean; depth?: string }) {
  return <span className={styles.link} data-busy={busy} data-depth={depth} aria-hidden />;
}

function where(routing: NonNullable<Lookup["routing"]>): number | undefined {
  // Each source is its own yes or no, so only a single named source has one share.
  if (routing.depth !== "search" || !routing.scope || routing.scope.includes("+")) return undefined;
  return share(routing.sources, routing.scope);
}
