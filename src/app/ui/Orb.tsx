"use client";

import { useEffect, useRef } from "react";
import styles from "./ui.module.css";

export type Mood = "idle" | "connecting" | "listening" | "hearing" | "thinking" | "speaking";

/**
 * The call, as one shape that breathes with whoever is talking.
 *
 * Levels are read every frame and written to a CSS variable rather than to
 * state, so sixty readings a second cost no React renders. It follows the
 * person while they talk and the model while it answers, which is the one
 * thing a voice call shows you that a transcript cannot: who has the floor.
 */
export function Orb({
  mood,
  meter,
  tint,
  size = "large",
}: {
  mood: Mood;
  meter: () => { input: number; output: number };
  /** The lane being fetched, so thinking shows what it costs. */
  tint?: string;
  size?: "large" | "small";
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frame = 0;
    let smooth = 0;
    const tick = () => {
      const { input, output } = meter();
      const level =
        mood === "speaking" ? output : mood === "listening" || mood === "hearing" ? input : 0;
      // Eased, so the shape swells and settles instead of flickering per frame.
      smooth += (level - smooth) * (level > smooth ? 0.35 : 0.08);
      ref.current?.style.setProperty("--level", smooth.toFixed(3));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [meter, mood]);

  return (
    <div
      ref={ref}
      className={styles.orb}
      data-mood={mood}
      data-size={size}
      data-tint={tint ?? "none"}
      aria-hidden
    >
      <span className={styles.orbHalo} />
      <span className={styles.orbRing} />
      <span className={styles.orbCore} />
    </div>
  );
}

export const MOOD_WORDS: Record<Mood, string> = {
  idle: "Type, or press Talk",
  connecting: "Opening the call",
  listening: "Listening",
  hearing: "Hearing you",
  thinking: "Looking it up",
  speaking: "Speaking",
};
