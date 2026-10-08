"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRealtime, type Engine, type Lane } from "@/lib/useRealtime";
import { Account } from "./ui/Account";
import { Details } from "./ui/Details";
import { Choices } from "./ui/Choices";
import { ExchangeCard, group } from "./ui/Exchange";
import { MOOD_WORDS, Orb, type Mood } from "./ui/Orb";
import { Suggestions } from "./ui/Suggestions";
import styles from "./ui/ui.module.css";

const VOICES = ["marin", "cedar", "alloy", "sage", "verse", "coral"];

const LANES: { id: Lane; label: string; help: string }[] = [
  {
    id: "auto",
    label: "Auto",
    help: "Jev picks how far to reach for each question",
  },
  { id: "record", label: "Record", help: "Read one stored record. About 1s" },
  { id: "search", label: "Search", help: "Search indexed content. About 10s" },
  {
    id: "reasoned",
    label: "Reasoned",
    help: "Full Copilot composes an answer. 30 to 60s",
  },
];

const ENGINES: { id: Engine; label: string; depth: string; help: string }[] = [
  {
    id: "jev",
    label: "Jev",
    depth: "auto",
    help: "Jev picks the cheapest reach that can answer: a record, a search or a composed answer",
  },
  {
    id: "picks",
    label: "LLM choice",
    depth: "picks",
    help: "A model holds Work IQ's tools and chooses its own calls. No Jev",
  },
  {
    id: "direct",
    label: "Ask",
    depth: "reasoned",
    help: "Work IQ composes every answer itself. No routing, 30 to 60s",
  },
];

export default function Home() {
  const {
    meter,
    hearing,
    phase,
    error,
    turns,
    lookups,
    speaking,
    start,
    stop,
    hush,
    ask,
    askText,
    writing,
    compare,
    lane,
    setLane,
    engine,
    setEngine,
    always,
    setAlways,
  } = useRealtime();
  const [voice, setVoice] = useState("marin");
  const [typed, setTyped] = useState("");
  const [opened, setOpened] = useState<string | null>(null);
  /** The choices sheet: null closed, "all" with nothing marked, or one lookup's picks. */
  // A lookup id to replay, "latest" for the newest one, or closed.
  const [choosing, setChoosing] = useState<string | null>(null);
  const [hidden, setHidden] = useState<string | null>(null);
  const live = phase === "live";
  const [web, setWeb] = useState(false);
  /** Whether this server has a realtime deployment, and whether the person wants voice. */
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const [input, setInput] = useState<"voice" | "text">("voice");
  const voiceOn = voiceAvailable && input === "voice";

  // The mode is a standing preference, so it survives a reload.
  useEffect(() => {
    const saved = localStorage.getItem("workiq-mode");
    if (ENGINES.some((e) => e.id === saved)) setEngine(saved as Engine);
  }, [setEngine]);
  const pickEngine = useCallback(
    (next: Engine) => {
      localStorage.setItem("workiq-mode", next);
      setEngine(next);
    },
    [setEngine],
  );

  useEffect(() => {
    if (localStorage.getItem("input-mode") === "text") setInput("text");
    fetch("/api/session")
      .then((r) => r.json())
      .then((d) => setVoiceAvailable(Boolean(d.enabled)))
      .catch(() => setVoiceAvailable(false));
  }, []);
  const pickInput = useCallback(
    (next: "voice" | "text") => {
      localStorage.setItem("input-mode", next);
      setInput(next);
      if (next === "text" && phase !== "idle" && phase !== "failed") stop();
    },
    [phase, stop],
  );

  useEffect(() => {
    fetch("/api/web")
      .then((r) => r.json())
      .then((d) => setWeb(Boolean(d.enabled)))
      .catch(() => setWeb(false));
  }, []);

  const exchanges = useMemo(() => group(turns, lookups), [turns, lookups]);
  const running = lookups.find((l) => l.status === "running");
  const mood: Mood =
    phase === "connecting"
      ? "connecting"
      : !live
        ? running || writing
          ? "thinking"
          : "idle"
        : speaking
          ? "speaking"
          : running
            ? "thinking"
            : hearing
              ? "hearing"
              : "listening";
  const tint = running
    ? engine === "picks"
      ? "picks"
      : engine === "direct"
        ? "reasoned"
        : lane === "auto"
          ? "unknown"
          : lane
    : undefined;

  // In a call a typed question joins the conversation and is answered aloud.
  // Otherwise it goes to the text model: no microphone, no session, no voice.
  const put = useCallback(
    (question: string) => {
      if (live) ask(question);
      else void askText(question);
    },
    [live, ask, askText],
  );

  const detail = lookups.find((l) => l.id === opened);
  const started = exchanges.length > 0;

  const composer = (
    <form
      className={styles.composer}
      onSubmit={(e) => {
        e.preventDefault();
        if (!typed.trim()) return;
        put(typed.trim());
        setTyped("");
      }}
    >
      <input
        className={styles.input}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        placeholder={
          live
            ? "Or type it"
            : voiceOn
              ? "Type a question, or press Talk to speak"
              : "Type a question"
        }
        aria-label="Question"
      />
      <button className={styles.send} type="submit" disabled={!typed.trim()}>
        Ask
      </button>
    </form>
  );

  const callButtons = voiceOn && (
    <div className={styles.callButtons}>
      {live && (
        <button className={styles.ghost} onClick={hush} disabled={!speaking}>
          Quiet
        </button>
      )}
      {live ? (
        <button className={styles.end} onClick={stop}>
          End
        </button>
      ) : (
        <button
          className={styles.talk}
          onClick={() => start(voice)}
          disabled={phase === "connecting"}
        >
          {phase === "connecting" ? "Connecting\u2026" : "Talk"}
        </button>
      )}
    </div>
  );

  return (
    <main className={styles.app} data-started={started}>
      <header className={styles.bar}>
        <div className={styles.brand}>
          <span className={styles.brandMark} />
          Work IQ, out loud
        </div>

        {/*
         * A person's override, never the model's. The spoken model is not told
         * this exists, so nothing said aloud can make a lookup reach further.
         */}
        {/*
         * How a workplace question reaches Work IQ, for voice and text alike.
         * Also never the model's choice.
         */}
        <div className={styles.modes}>
          <div
            className={styles.lanes}
            role="radiogroup"
            aria-label="Work IQ mode"
          >
            <span className={styles.lanesLabel}>Work IQ</span>
            {ENGINES.map((option) => (
              <button
                key={option.id}
                role="radio"
                aria-checked={engine === option.id}
                className={styles.lane}
                data-depth={option.depth}
                data-on={engine === option.id}
                title={option.help}
                onClick={() => pickEngine(option.id)}
              >
                <span className={styles.receiptDot} />
                {option.label}
              </button>
            ))}
          </div>

          {/* Reach is Jev's choice to make or to have overridden, so only in Jev mode. */}
          {engine === "jev" && (
            <div
              className={styles.lanes}
              role="radiogroup"
              aria-label="How far to reach"
            >
              {LANES.map((option) => (
                <button
                  key={option.id}
                  role="radio"
                  aria-checked={lane === option.id}
                  className={styles.lane}
                  data-depth={option.id}
                  data-on={lane === option.id}
                  title={option.help}
                  onClick={() => setLane(option.id)}
                >
                  <span className={styles.receiptDot} />
                  {option.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className={styles.barRight}>
          <button
            className={styles.howButton}
            onClick={() => setChoosing("latest")}
            title="Every tool and every Jev option, with the words that decide between them"
          >
            How it chooses
          </button>
          {web && (
            <span
              className={styles.webOn}
              data-depth="web"
              title="The model can also search the public web through Microsoft Web IQ. It decides when."
            >
              <span className={styles.receiptDot} />
              Web IQ
            </span>
          )}
          <label
            className={styles.toggle}
            title="After each answer, ask the same question the two other ways and time all three"
          >
            <input
              type="checkbox"
              checked={always}
              onChange={(e) => setAlways(e.target.checked)}
            />
            <span className={styles.switch} />
            Compare
          </label>
          {voiceAvailable && (
            <div className={styles.lanes} role="radiogroup" aria-label="Input">
              {(["voice", "text"] as const).map((option) => (
                <button
                  key={option}
                  role="radio"
                  aria-checked={input === option}
                  className={styles.lane}
                  data-on={input === option}
                  title={
                    option === "voice"
                      ? "Talk to the realtime model, or type"
                      : "Type only. Answers are written by the chat model, no microphone"
                  }
                  onClick={() => pickInput(option)}
                >
                  {option === "voice" ? "Voice" : "Text"}
                </button>
              ))}
            </div>
          )}
          {voiceOn && (
            <select
              className={styles.voice}
              value={voice}
              onChange={(e) => setVoice(e.target.value)}
              disabled={phase !== "idle" && phase !== "failed"}
              aria-label="Voice"
            >
              {VOICES.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          )}
          <Account />
        </div>
      </header>

      {error && error !== hidden && (
        <div className={styles.toast} role="alert">
          <span>{error}</span>
          <button onClick={() => setHidden(error)} aria-label="Dismiss">
            {"\u2715"}
          </button>
        </div>
      )}

      {!started ? (
        <section className={styles.hero}>
          <Orb mood={mood} meter={meter} tint={tint} />
          <p className={styles.mood} data-mood={mood}>
            {mood === "idle" && !voiceOn ? "Type a question" : MOOD_WORDS[mood]}
          </p>
          <h1 className={styles.headline}>
            {web
              ? "Ask about your work, or the world."
              : "Ask about your work."}
          </h1>
          <p className={styles.lede}>
            Mail, calendar, chats, files and colleagues. Jev decides how far to
            reach before anything is fetched, so most answers come back in about
            a second.
            {voiceOn
              ? " Type to get a written answer, or press Talk to have a conversation."
              : " Answers are written by a chat model."}
            {web &&
              " News, weather, markets and anything public go to Web IQ in under a second."}
          </p>
          <div className={styles.heroControls}>
            {callButtons}
            {composer}
          </div>
          <Suggestions onPick={put} web={web} />
        </section>
      ) : (
        <>
          <section className={styles.dock}>
            <Orb mood={mood} meter={meter} tint={tint} size="small" />
            <p className={styles.mood} data-mood={mood}>
              {mood === "idle" && !voiceOn
                ? "Type a question"
                : MOOD_WORDS[mood]}
            </p>
            {composer}
            {callButtons}
          </section>

          {/* Newest first. The one just asked is the one being read. */}
          <section className={styles.feed}>
            {exchanges.map((exchange) => (
              <ExchangeCard
                key={exchange.id || "opening"}
                exchange={exchange}
                live={live || writing}
                onOpen={setOpened}
              />
            ))}
          </section>
        </>
      )}

      {detail && (
        <Details
          lookup={detail}
          compare={compare}
          onClose={() => setOpened(null)}
          onExplain={() => {
            setOpened(null);
            setChoosing(detail.id);
          }}
        />
      )}
      {choosing && (
        <Choices
          lookup={
            (choosing === "latest"
              ? lookups[lookups.length - 1]
              : lookups.find((l) => l.id === choosing)) ?? null
          }
          onClose={() => setChoosing(null)}
        />
      )}
    </main>
  );
}
