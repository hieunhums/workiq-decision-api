"use client";

import { useEffect, useMemo, useState } from "react";
import type { Choice } from "@/app/api/choices/route";
import type { Lookup } from "@/lib/useRealtime";
import { ms, share } from "./measure";
import styles from "./Replay.module.css";

type Pick = { id: string; label?: string; note?: string; odds?: number; depth: string };

type Column = {
  who: string;
  what: string;
  /** Real time this choice took, as measured. */
  took?: string;
  options: Pick[];
  /** Ids that were taken. More than one only for Work IQ calls and web kinds. */
  picked: Set<string>;
  /** How long the replay lets this column scan, in ms. Scaled from `took`. */
  hold: number;
};

/**
 * One lookup's choices exploded into columns, replayed in order: every option
 * a chooser had bursts out, scans, and the one taken locks. Hold times are the
 * real ones compressed, so a slow Work IQ call still looks slow next to Jev.
 * While the lookup is still running, it shows the live state instead.
 */
export function Replay({ lookup, choices }: { lookup: Lookup; choices: Choice[] }) {
  const columns = useMemo(() => build(lookup, choices), [lookup, choices]);
  const live = lookup.status === "running";
  const [run, setRun] = useState(0);
  const [at, setAt] = useState(0);

  useEffect(() => {
    if (live) return;
    setAt(0);
    let index = 0;
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      index += 1;
      setAt(index);
      if (index < columns.length) timer = setTimeout(next, columns[index].hold);
    };
    timer = setTimeout(next, columns[0]?.hold ?? 800);
    return () => clearTimeout(timer);
  }, [columns, live, run]);

  // Live: every column whose choice has landed is locked, the next one scans.
  const reached = live ? columns.findIndex((c) => c.picked.size === 0) : at;
  const active = reached === -1 ? columns.length : reached;

  return (
    <div className={styles.replay}>
      <div className={styles.head}>
        <p className={styles.question}>
          <span className={styles.kicker}>{live ? "Choosing now" : "Replay"}</span>
          {live ? "Each column locks as its choice lands." : "Every option each chooser had, in the order they chose."}
        </p>
        {!live && (
          <button className={styles.again} onClick={() => setRun((r) => r + 1)}>
            {"\u21BB"} Replay
          </button>
        )}
      </div>
      <div className={styles.columns} key={run}>
        {columns.map((column, index) => {
          const state = index < active ? "locked" : index === active ? "scanning" : "waiting";
          return (
            <div key={index} className={styles.column} data-state={state}>
              {index > 0 && <span className={styles.wire} data-state={state} aria-hidden />}
              <p className={styles.who}>
                {column.who}
                {state === "locked" && column.took && (
                  <span className={styles.took}>{column.took}</span>
                )}
              </p>
              <p className={styles.what}>{column.what}</p>
              {state !== "waiting" && (
                <div
                  className={styles.options}
                  data-many={column.options.length > 6}
                  style={{ "--n": column.options.length } as React.CSSProperties}
                >
                  {column.options.map((option, i) => {
                    const on = column.picked.has(option.id);
                    return (
                      <div
                        key={option.id + i}
                        className={styles.option}
                        data-depth={option.depth}
                        data-on={state === "locked" && on}
                        data-off={state === "locked" && !on}
                        style={{ "--i": i } as React.CSSProperties}
                      >
                        <span className={styles.name}>
                          <span className={styles.dot} />
                          {option.label ?? option.id}
                          {option.note && <em>{option.note}</em>}
                        </span>
                        {option.odds !== undefined && (
                          <span className={styles.bar}>
                            <span className={styles.track}>
                              <span
                                style={{
                                  width: state === "locked" ? `${Math.max(option.odds * 100, 1)}%` : 0,
                                }}
                              />
                            </span>
                            <em>{Math.round(option.odds * 100)}%</em>
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function build(lookup: Lookup, choices: Choice[]): Column[] {
  const options = (key: string) => choices.find((c) => c.key === key);
  const tool = options("tool");
  const web = lookup.kind === "web";
  const done = lookup.status !== "running";

  const columns: Column[] = [
    {
      who: lookup.written ? "Text model" : "Voice model",
      what: "Which tool, if any",
      options: [
        ...(tool?.options ?? []).map((o) => ({
          id: o.id,
          note: o.id === "search_web" ? "Web IQ" : "Work IQ",
          depth: o.id === "search_web" ? "web" : "search",
        })),
        { id: "none", note: "just talk", depth: "none" },
      ],
      picked: new Set([web ? "search_web" : "ask_workplace"]),
      hold: 900,
    },
  ];

  if (web) {
    const counts = new Map<string, number>();
    for (const s of lookup.sources ?? []) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
    columns.push({
      who: "Web IQ",
      what: "sonic, plus images or videos if asked",
      took: lookup.seconds ? `${lookup.seconds.toFixed(1)}s` : undefined,
      options: ["web", "news", "weather", "finance", "image", "video"].map((id) => ({
        id,
        note: counts.get(id) ? `${counts.get(id)}` : undefined,
        depth: "web",
      })),
      picked: done ? new Set([...counts.keys()]) : new Set(),
      hold: hold(lookup.seconds, 1100),
    });
    columns.push(result(lookup, "web"));
    return columns;
  }

  if (lookup.engine === "picks" || lookup.engine === "direct") {
    const picks = lookup.engine === "picks";
    const steps = lookup.steps ?? [];
    const depth = picks ? "picks" : "reasoned";
    columns.push(
      picks
        ? {
            who: "Model with Work IQ's tools",
            what: "Chooses its own calls, no Jev",
            took:
              done && lookup.modelSeconds !== undefined
                ? `${lookup.modelSeconds.toFixed(1)}s deciding`
                : undefined,
            options: steps.length
              ? steps.map((s, i) => ({
                  id: `${s.tool}-${i}`,
                  label: s.tool,
                  note: `${s.seconds.toFixed(1)}s`,
                  depth,
                }))
              : [{ id: "none", label: done ? "no calls" : "choosing", depth: "none" }],
            picked: done ? new Set(steps.flatMap((s, i) => (s.failed ? [] : [`${s.tool}-${i}`]))) : new Set(),
            hold: hold(lookup.seconds, 1400),
          }
        : {
            who: "Work IQ",
            what: "Composes an answer, no routing",
            took: done && lookup.seconds ? `${lookup.seconds.toFixed(1)}s` : undefined,
            options: [{ id: "ask", label: "ask", depth }],
            picked: done ? new Set(["ask"]) : new Set(),
            hold: hold(lookup.seconds, 1400),
          },
    );
    columns.push(result(lookup, depth));
    return columns;
  }

  const routing = lookup.routing ?? lookup.trace?.routing;
  const reachOdds = routing?.reach?.ranked;
  columns.push({
    who: "Jev",
    what: "How far to reach",
    took: routing ? (routing.forced ? "set by you" : ms(routing.seconds)) : undefined,
    options: [
      ...(options("workplace_reach")?.options ?? []).map((o) => ({
        id: o.id,
        label: o.id === "reasoned" ? "compose" : o.id,
        note: o.cost?.replace("about ", "~"),
        odds: routing?.forced ? undefined : share(reachOdds, o.id),
        depth: o.id,
      })),
      ...(share(reachOdds, "none_here") !== undefined && !routing?.forced
        ? [{ id: "none_here", label: "not here", odds: share(reachOdds, "none_here"), depth: "none" }]
        : []),
    ],
    picked: routing ? new Set([routing.depth]) : new Set(),
    hold: Math.max(1100, (routing?.seconds ?? 0.4) * 2500),
  });

  if (!routing) return columns;

  if (routing.depth === "record") {
    columns.push({
      who: "Jev",
      what: "Which of your records",
      took: "same call",
      options: (options("workplace_path")?.options ?? []).map((o) => ({ id: o.id, depth: "record" })),
      picked: new Set(routing.record ? [routing.record] : []),
      hold: 1000,
    });
  } else if (routing.depth === "search") {
    const odds = routing.sources;
    columns.push({
      who: "Jev",
      what: "Which sources are named",
      took: "same call",
      options: [
        ...(options("workplace_sources")?.options ?? []).map((o) => ({
          id: o.id,
          odds: share(odds, o.id),
          depth: "search",
        })),
        { id: "none", label: "everywhere", depth: "search" },
      ],
      picked: new Set(routing.scope ? routing.scope.split("+") : ["none"]),
      hold: 1000,
    });
  }

  const steps = lookup.trace?.steps ?? [];
  const call = { record: "fetch", search: "retrieve", reasoned: "ask" }[routing.depth];
  columns.push({
    who: "Work IQ",
    what: routing.depth === "reasoned" ? "Composes an answer" : "Runs only that call",
    took: done && lookup.seconds ? `${lookup.seconds.toFixed(1)}s` : undefined,
    options: steps.length
      ? steps.map((s, i) => ({
          id: `${s.tool}-${i}`,
          label: s.tool,
          note: s.found === null ? "\u2713" : `${s.found} found`,
          depth: routing.depth,
        }))
      : [{ id: `${call}-0`, label: call, depth: routing.depth }],
    picked: done ? new Set(steps.map((s, i) => `${s.tool}-${i}`)) : new Set(),
    hold: hold(lookup.seconds, 1400),
  });
  columns.push(result(lookup, routing.depth));
  return columns;
}

function result(lookup: Lookup, depth: string): Column {
  const failed = lookup.status === "failed";
  const empty = lookup.found === false;
  const label = failed
    ? "failed"
    : empty
      ? "found nothing"
      : lookup.written
        ? "written back"
        : "spoken back";
  return {
    who: "Answer",
    what: lookup.written ? "Text only, to the text model" : "Text only, to the voice model",
    took: lookup.seconds ? `${lookup.seconds.toFixed(1)}s total` : undefined,
    options: [{ id: "answer", label, depth: failed || empty ? "none" : depth }],
    picked: lookup.status === "running" ? new Set() : new Set(["answer"]),
    hold: 600,
  };
}

/** Real seconds compressed into a replay hold, keeping slow things slower. */
function hold(seconds: number | undefined, least: number): number {
  if (!seconds) return least;
  return Math.min(3600, least + Math.log10(1 + seconds) * 1400);
}
