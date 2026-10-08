"use client";

import { useEffect, useState } from "react";
import type { Certainty, Lookup, Odds, Rival } from "@/lib/useRealtime";
import { depthOf, describe } from "./Exchange";
import styles from "./ui.module.css";

/**
 * Everything behind one lookup: why that lane, what each step cost, and how
 * the same question fared answered the two other ways.
 *
 * A sheet rather than part of the card. It is four panels of bars, and inline
 * it buried the answer it was there to explain.
 */
export function Details({
  lookup,
  compare,
  onClose,
  onExplain,
}: {
  lookup: Lookup;
  compare: (id: string, question: string) => void;
  onClose: () => void;
  onExplain: () => void;
}) {
  useEffect(() => {
    const close = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);

  const routing = lookup.trace?.routing;
  const steps = lookup.trace?.steps ?? [];
  const span = lookup.seconds || 1;

  return (
    <>
      <div className={styles.scrim} onClick={onClose} />
      <aside className={styles.drawer} data-depth={depthOf(lookup)} role="dialog" aria-label="How this was answered">
        <header className={styles.drawerHead}>
          <div>
            <p className={styles.drawerKicker}>How this was answered</p>
            <h3 className={styles.drawerTitle}>{lookup.question || "\u2026"}</h3>
          </div>
          <button className={styles.close} onClick={onClose} aria-label="Close">
            {"\u2715"}
          </button>
        </header>

        {lookup.status === "running" && <p className={styles.muted}>Still running.</p>}
        {lookup.status === "done" && (
          <button className={styles.explain} onClick={onExplain}>
            See every option it had, and why this one
          </button>
        )}
        {lookup.error && <p className={styles.errorText}>{lookup.error}</p>}

        {lookup.kind === "web" && lookup.status === "done" && (
          <section className={styles.section}>
            <div className={styles.summary}>
              <span className={styles.summaryLane}>web</span>
              <span className={styles.summaryWhat}>
                Searched Web IQ for {"\u201c"}{lookup.question}{"\u201d"}
              </span>
              <span className={styles.summaryTime}>{lookup.seconds?.toFixed(1)}s</span>
            </div>
            <p className={styles.note}>
              The model wrote this query itself. Web questions skip Jev: there is one
              reach, so nothing to route. Read {lookup.sources?.length ?? 0} source
              {lookup.sources?.length === 1 ? "" : "s"}.
            </p>
            {lookup.found === false && (
              <p className={styles.note}>Found nothing. That is not the same as none existing.</p>
            )}
          </section>
        )}

        {lookup.kind === "workplace" && lookup.engine && lookup.engine !== "jev" && (
          <section className={styles.section}>
            <div className={styles.summary}>
              <span className={styles.summaryLane}>
                {lookup.engine === "picks" ? "model picks" : "Work IQ ask"}
              </span>
              <span className={styles.summaryWhat}>
                {lookup.engine === "picks"
                  ? "A model held Work IQ's tools and chose its own calls"
                  : "Work IQ composed the answer, no routing"}
              </span>
              <span className={styles.summaryTime}>{lookup.seconds?.toFixed(1)}s</span>
            </div>
            <p className={styles.note}>
              You picked this mode at the top of the page. Jev was not asked.
            </p>
            {lookup.found === false && (
              <p className={styles.note}>Found nothing. That is not the same as none existing.</p>
            )}
            {lookup.engine === "picks" && lookup.status === "done" && (
              <div className={styles.timeline}>
                {lookup.modelSeconds !== undefined && (
                  <Tick
                    what="The model deciding"
                    seconds={lookup.modelSeconds}
                    span={span}
                    thinking
                  />
                )}
                {(lookup.steps ?? []).map((step, index) => (
                  <Tick
                    key={index}
                    what={step.tool}
                    seconds={step.seconds}
                    span={span}
                    note={step.failed ? "failed" : step.args.slice(0, 80)}
                  />
                ))}
                <Axis span={span} />
              </div>
            )}
          </section>
        )}

        {routing && (
          <section className={styles.section}>
            <div className={styles.summary}>
              <span className={styles.summaryLane}>{routing.depth}</span>
              <span className={styles.summaryWhat}>{describe(routing)}</span>
              <span className={styles.summaryTime}>{lookup.seconds?.toFixed(1)}s</span>
            </div>
            {routing.forced && (
              <p className={styles.note}>
                Forced by you. Jev would have picked{" "}
                <b>{routing.reach?.ranked[0]?.id ?? "?"}</b>.
              </p>
            )}
            {routing.overruled && <p className={styles.note}>{routing.overruled}</p>}
            {routing.meaning && <p className={styles.meaning}>{routing.meaning}</p>}
            {routing.narrowedFrom && (
              <p className={styles.note}>
                Jev picked your {routing.narrowedFrom} list, but the question names one
                particular thing, so it searched {routing.scope ?? "everywhere"} instead of
                reading only the latest few.
              </p>
            )}
            {routing.parts?.length > 0 && (
              <ol className={styles.note}>
                {routing.parts.map((part, i) => (
                  <li key={i}>
                    <b>{part.question}</b>: {describe(part)}
                  </li>
                ))}
              </ol>
            )}
            {lookup.found === false && (
              <p className={styles.note}>Found nothing. That is not the same as none existing.</p>
            )}
          </section>
        )}

        {routing && (
          <section className={styles.section}>
            <h4 className={styles.sectionTitle}>Where the time went</h4>
            <div className={styles.timeline}>
              <Tick what="Jev routed it" seconds={routing.seconds} span={span} thinking />
              {steps.map((step, index) => (
                <Tick
                  key={index}
                  what={step.what}
                  seconds={step.seconds}
                  span={span}
                  note={`${step.tool}${step.found !== null ? ` \u00b7 ${step.found} found` : ""}`}
                />
              ))}
              <Axis span={span} />
            </div>
          </section>
        )}

        {lookup.status === "done" &&
          lookup.kind === "workplace" &&
          (!lookup.engine || lookup.engine === "jev") && (
          <section className={styles.section}>
            <h4 className={styles.sectionTitle}>Against the alternatives</h4>
            <Compared lookup={lookup} compare={compare} />
          </section>
        )}

        {routing && (
          <section className={styles.section}>
            <h4 className={styles.sectionTitle}>What Jev weighed</h4>
            <Weighed label="How far to reach" certainty={routing.reach} />
            <Likely label="Does the question name it" odds={routing.sources ?? []} />
          </section>
        )}
      </aside>
    </>
  );
}

function Axis({ span }: { span: number }) {
  return (
    <div className={styles.axis}>
      <span>0s</span>
      <span>{span.toFixed(1)}s</span>
    </div>
  );
}

/**
 * The same question answered three ways on one clock: routed by Jev, by a
 * model holding Work IQ's tools and choosing its own calls, and by Work IQ's
 * composing answer with no routing at all.
 *
 * The rivals' answers are shown, not just their times. Asked about tomorrow,
 * the self-picking model read the calendar with no date filter and reported
 * the wrong meetings, which a stopwatch cannot show.
 */
function Compared({
  lookup,
  compare,
}: {
  lookup: Lookup;
  compare: (id: string, question: string) => void;
}) {
  const rivals = lookup.rivals;
  const routed = lookup.seconds ?? 0;

  if (!rivals) {
    return (
      <button className={styles.measure} onClick={() => compare(lookup.id, lookup.question)}>
        Compare with the model picking tools, and with Work IQ ask alone
      </button>
    );
  }

  const lanes: { key: string; label: string; rival: Rival }[] = [
    { key: "routed", label: "Jev routed", rival: { status: "done", seconds: routed } },
    { key: "picks", label: "Model picks tools", rival: rivals.picks ?? { status: "running" } },
    { key: "direct", label: "Work IQ ask", rival: rivals.direct ?? { status: "running" } },
  ];
  // The axis grows as rivals finish, so the routed bar shrinks in real time.
  const span = Math.max(routed, ...lanes.map((l) => l.rival.seconds ?? 0), 0.1);

  return (
    <div className={styles.compared}>
      <Headline routed={routed} rivals={rivals} />
      {lanes.map(({ key, label, rival }) => (
        <div key={key} className={styles.tick} data-kind={key} data-status={rival.status}>
          <span className={styles.tickWhat}>{label}</span>
          <span className={styles.tickBar}>
            {rival.status === "running" ? (
              <span className={styles.pending} />
            ) : (
              <span
                className={styles.tickFill}
                style={{ width: `${Math.max(1, ((rival.seconds ?? 0) / span) * 100)}%` }}
              />
            )}
          </span>
          <span className={styles.tickCost}>
            {rival.status === "running"
              ? "\u2026"
              : rival.status === "failed"
                ? "failed"
                : `${rival.seconds?.toFixed(1)}s`}
          </span>
        </div>
      ))}
      <Axis span={span} />

      {(["picks", "direct"] as const).map((kind) => {
        const rival = rivals[kind];
        if (!rival || rival.status === "running") return null;
        return <RivalAnswer key={kind} kind={kind} rival={rival} />;
      })}
    </div>
  );
}

/** How much faster, against the nearest rival. Beating the slow one is not a claim. */
function Headline({ routed, rivals }: { routed: number; rivals: Lookup["rivals"] }) {
  const picks = rivals?.picks;
  const direct = rivals?.direct;
  const done = [picks, direct].filter(
    (r): r is Rival & { seconds: number } => r?.status === "done" && r.seconds !== undefined,
  );
  if (done.length === 0) {
    return <p className={styles.measuring}>Asking it the other two ways…</p>;
  }
  const nearest = Math.min(...done.map((r) => r.seconds));
  const against = nearest === picks?.seconds ? "the model picking tools" : "asking plainly";
  const saved = nearest - routed;
  if (saved <= 0.2) {
    return (
      <p className={styles.measuring}>
        {against[0].toUpperCase() + against.slice(1)} took {nearest.toFixed(1)}s. Routing saved
        nothing here.
      </p>
    );
  }
  return (
    <p className={styles.saved}>
      <b>{(nearest / Math.max(routed, 0.01)).toFixed(1)}x faster</b> than {against},{" "}
      {saved.toFixed(1)}s saved
    </p>
  );
}

function RivalAnswer({ kind, rival }: { kind: "picks" | "direct"; rival: Rival }) {
  const [open, setOpen] = useState(false);
  const label = kind === "picks" ? "What the model picking tools said" : "What Work IQ ask said";
  return (
    <div className={styles.rivalAnswer}>
      <button className={styles.evidenceToggle} onClick={() => setOpen(!open)}>
        <span className={styles.caret} data-open={open}>
          {"\u203A"}
        </span>
        {label}
        {kind === "picks" && rival.steps && (
          <span className={styles.muted}>
            {" "}
            · {rival.steps.length} call{rival.steps.length === 1 ? "" : "s"}
            {rival.modelSeconds !== undefined && `, ${rival.modelSeconds.toFixed(1)}s deciding`}
          </span>
        )}
      </button>
      {open && (
        <>
          {rival.error && <p className={styles.errorText}>{rival.error}</p>}
          {rival.steps?.map((step, index) => (
            <p key={index} className={styles.call} data-failed={step.failed}>
              <span>{step.tool}</span> {step.args} <span>{step.seconds.toFixed(2)}s</span>
            </p>
          ))}
          {rival.text && <pre className={styles.raw}>{rival.text}</pre>}
        </>
      )}
    </div>
  );
}

/** One row of a timeline: what happened, how long, as a share of the whole. */
function Tick({
  what,
  seconds,
  span,
  note,
  thinking,
}: {
  what: string;
  seconds: number;
  span: number;
  note?: string;
  thinking?: boolean;
}) {
  return (
    <div className={styles.tick} data-thinking={thinking ?? false}>
      <span className={styles.tickWhat}>{what}</span>
      <span className={styles.tickBar}>
        <span
          className={styles.tickFill}
          style={{ width: `${Math.max(1, (seconds / span) * 100)}%` }}
        />
      </span>
      <span className={styles.tickCost}>{seconds.toFixed(2)}s</span>
      {note && <span className={styles.tickNote}>{note}</span>}
    </div>
  );
}

/**
 * The whole distribution, not just the winner. A narrow gap between the top
 * two means the options read alike, which is worth knowing when the answer
 * turns out to be wrong.
 */
/** Yes or no questions, each its own probability, so they need not add up. */
function Likely({ label, odds }: { label: string; odds: Odds[] }) {
  if (!odds.length) return null;
  return (
    <div className={styles.weighed}>
      <div className={styles.weighedHead}>
        <span>{label}</span>
        <span className={styles.muted}>each asked on its own</span>
      </div>
      {odds.map((o) => (
        <div key={o.id} className={styles.odds}>
          <span className={styles.oddsName}>{o.id}</span>
          <span className={styles.oddsBar}>
            <span className={styles.fill} style={{ width: `${o.probability * 100}%` }} />
          </span>
          <span className={styles.oddsValue}>{Math.round(o.probability * 100)}%</span>
        </div>
      ))}
    </div>
  );
}

function Weighed({ label, certainty }: { label: string; certainty: Certainty | null }) {
  if (!certainty) return null;
  return (
    <div className={styles.weighed}>
      <div className={styles.weighedHead}>
        <span>{label}</span>
        <span className={styles.muted}>{Math.round(certainty.confidence * 100)}% sure</span>
      </div>
      {certainty.ranked.slice(0, 4).map((odds) => (
        <div key={odds.id} className={styles.odds}>
          <span className={styles.oddsName}>
            {odds.id === "none_here" ? "none of these" : odds.id}
          </span>
          <span className={styles.oddsBar}>
            <span className={styles.fill} style={{ width: `${odds.probability * 100}%` }} />
          </span>
          <span className={styles.oddsValue}>{Math.round(odds.probability * 100)}%</span>
        </div>
      ))}
    </div>
  );
}
