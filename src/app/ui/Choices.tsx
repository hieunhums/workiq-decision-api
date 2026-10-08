"use client";

import { useEffect, useState } from "react";
import type { Choice } from "@/app/api/choices/route";
import type { Lookup, Odds } from "@/lib/useRealtime";
import { Replay } from "./Replay";
import styles from "./ui.module.css";

/** What one lookup actually picked, to mark against the full set of options. */
export type Picked = {
  question: string;
  tool: string;
  reach?: string;
  record?: string | null;
  scope?: string | null;
  reachOdds?: Odds[];
  scopeOdds?: Odds[];
};

function pickedFrom(lookup: Lookup): Picked {
  if (lookup.kind === "web")
    return { question: lookup.question, tool: "search_web" };
  const r = lookup.routing ?? lookup.trace?.routing;
  return {
    question: lookup.question,
    tool: "ask_workplace",
    reach: r?.depth,
    record: r?.depth === "record" ? r.record : null,
    scope: r?.depth === "search" ? (r.scope ?? "none") : null,
    reachOdds: r?.reach?.ranked,
    scopeOdds: r?.sources,
  };
}

const TITLES: Record<string, string> = {
  tool: "Which tool",
  workplace_reach: "How far to reach",
  workplace_path: "Which record",
  workplace_sources: "Which sources are named",
};

const STEPS: Record<string, string> = {
  tool: "1",
  workplace_reach: "2",
  workplace_path: "3a",
  workplace_sources: "3b",
};

/**
 * Every option at every step, with the exact words the chooser reads. Opened
 * from a lookup, it marks what that lookup picked and how likely Jev thought
 * each option was.
 */
export function Choices({
  lookup,
  onClose,
}: {
  /** The lookup to replay and mark, usually the latest. Null shows options only. */
  lookup: Lookup | null;
  onClose: () => void;
}) {
  const picked = lookup ? pickedFrom(lookup) : null;
  const [choices, setChoices] = useState<Choice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unfolded, setUnfolded] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch("/api/choices")
      .then((r) => r.json())
      .then((d) => setChoices(d.choices))
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    const close = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);

  const chosen = (key: string): string | null | undefined => {
    if (!picked) return undefined;
    if (key === "tool") return picked.tool;
    if (picked.tool !== "ask_workplace") return null;
    if (key === "workplace_reach") return picked.reach;
    if (key === "workplace_path") return picked.record;
    if (key === "workplace_sources") return picked.scope;
    return undefined;
  };
  const odds = (key: string): Map<string, number> =>
    new Map(
      (key === "workplace_reach"
        ? picked?.reachOdds
        : key === "workplace_sources"
          ? picked?.scopeOdds
          : []
      )?.map((o) => [o.id, o.probability]) ?? [],
    );

  return (
    <>
      <div className={styles.scrim} onClick={onClose} />
      <aside
        className={`${styles.drawer} ${styles.full}`}
        role="dialog"
        aria-label="How it chooses"
      >
        <header className={styles.drawerHead}>
          <div>
            <p className={styles.drawerKicker}>How it chooses</p>
            <h3 className={styles.drawerTitle}>
              {picked
                ? picked.question || "\u2026"
                : "Every option, and what decides it"}
            </h3>
          </div>
          <button className={styles.close} onClick={onClose} aria-label="Close">
            {"\u2715"}
          </button>
        </header>

        {lookup && choices && <Replay lookup={lookup} choices={choices} />}

        <div className={styles.fullBody}>
          <section className={styles.section}>
            <ol className={styles.flow}>
              <li>
                <b>The model</b> (voice in a call, text when typed) picks a tool from the tool
                descriptions. Everything below about Jev applies in the <b>Jev</b> Work IQ
                mode; <b>LLM choice</b> and <b>Ask</b> skip Jev.
              </li>
              <li>
                <b>search_web</b> goes straight to Web IQ. Nothing to route.
              </li>
              <li>
                <b>ask_workplace</b> goes to <b>Jev</b>, which answers steps 2,
                3a and 3b in one call, from the meanings below. No keywords, no
                regex. In a second call at the same time, Jev counts the separate
                requests and marks where each starts and ends; each request is
                then planned and looked up on its own.
              </li>
              <li>Work IQ runs only the cheapest reach Jev picked.</li>
              <li>
                Jev then checks whether a fast result holds what was asked. A doubted
                result is asked again of the composing reach.
              </li>
            </ol>
            {picked && (
              <p className={styles.note}>
                Marked: what this question picked. Bars: how likely Jev rated
                each option.
              </p>
            )}
          </section>

          {error && <p className={styles.errorText}>{error}</p>}
          {!choices && !error && <p className={styles.muted}>Loading.</p>}

          {choices?.map((choice) => {
            const pick = chosen(choice.key);
            const likely = odds(choice.key);
            const skipped = picked && pick === null;
            return (
              <section
                key={choice.key}
                className={styles.section}
                data-skipped={Boolean(skipped)}
              >
                <div className={styles.choiceHead}>
                  <span className={styles.step}>{STEPS[choice.key]}</span>
                  <h4 className={styles.choiceTitle}>
                    {TITLES[choice.key] ?? choice.key}
                  </h4>
                  <span className={styles.choiceWho}>{choice.who}</span>
                </div>
                <p className={styles.asks}>{choice.asks}</p>
                {skipped && (
                  <button
                    className={styles.explain}
                    onClick={() =>
                      setUnfolded((all) => {
                        const next = new Set(all);
                        if (next.has(choice.key)) next.delete(choice.key);
                        else next.add(choice.key);
                        return next;
                      })
                    }
                  >
                    Not used for this question.{" "}
                    {unfolded.has(choice.key)
                      ? "Hide options"
                      : `Show ${choice.options.length} options`}
                  </button>
                )}

                {(!skipped || unfolded.has(choice.key)) && (
                  <div className={styles.options}>
                    {choice.options.map((option) => {
                      const p = likely.get(option.id);
                      return (
                        <div
                          key={option.id}
                          className={styles.option}
                          data-depth={depth(choice.key, option.id)}
                          data-picked={
                            pick === option.id ||
                            (choice.key === "workplace_sources" &&
                              Boolean(pick?.split("+").includes(option.id)))
                          }
                          data-off={option.enabled === false}
                        >
                          <div className={styles.optionHead}>
                            <span className={styles.receiptDot} />
                            <code className={styles.optionId}>{option.id}</code>
                            {pick === option.id && (
                              <span className={styles.pickedTag}>picked</span>
                            )}
                            {option.enabled === false && (
                              <span className={styles.receiptTag}>
                                off, no key
                              </span>
                            )}
                            {option.cost && (
                              <span className={styles.optionCost}>
                                {option.cost}
                              </span>
                            )}
                          </div>
                          <p className={styles.optionMeaning}>
                            {option.meaning}
                          </p>
                          {option.detail && (
                            <p className={styles.optionDetail}>
                              {option.detail}
                            </p>
                          )}
                          {p !== undefined && (
                            <div
                              className={styles.odds}
                              title={`${Math.round(p * 100)}%`}
                            >
                              <span
                                style={{ width: `${Math.max(p * 100, 1)}%` }}
                              />
                              <em>{Math.round(p * 100)}%</em>
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {choice.none && (
                      <div
                        className={styles.option}
                        data-depth="none"
                        data-picked={
                          pick === "none" ||
                          (choice.key === "tool" && pick === "")
                        }
                      >
                        <div className={styles.optionHead}>
                          <span className={styles.receiptDot} />
                          <code className={styles.optionId}>none</code>
                          {pick === "none" && (
                            <span className={styles.pickedTag}>picked</span>
                          )}
                        </div>
                        <p className={styles.optionMeaning}>{choice.none}</p>
                        {likely.get("none_here") !== undefined && (
                          <div className={styles.odds}>
                            <span
                              style={{
                                width: `${Math.max(likely.get("none_here")! * 100, 1)}%`,
                              }}
                            />
                            <em>
                              {Math.round(likely.get("none_here")! * 100)}%
                            </em>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </section>
            );
          })}

          <section className={styles.section}>
            <div className={styles.choiceHead}>
              <span className={styles.step}>4</span>
              <h4 className={styles.choiceTitle}>When it comes back empty</h4>
            </div>
            <ol className={styles.flow}>
              <li>
                A search narrowed to one source that finds nothing runs again
                over every source. Same call, no filter.
              </li>
              <li>
                Still nothing: the model is told plainly, and says it found
                nothing rather than that none exists.
              </li>
              <li>
                Fallback depends on an empty result, never on Jev&apos;s
                confidence. Over 102 questions, right routings scored as low as
                0.10 and wrong ones as high as 0.93.
              </li>
            </ol>
          </section>
        </div>
      </aside>
    </>
  );
}

function depth(key: string, id: string): string {
  if (key === "workplace_reach") return id;
  if (key === "tool") return id === "search_web" ? "web" : "auto";
  if (key === "workplace_path") return "record";
  if (key === "workplace_scope") return "search";
  return "none";
}
