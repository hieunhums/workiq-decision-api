import corpus from "./questions.json";

/**
 * The questions the routing is demonstrated with and checked against.
 *
 * One list does both jobs, which is the point of it. What gets offered to a
 * person on the empty screen is exactly what `npm run route-check` measures,
 * so a topic that is pleasant to suggest but routes badly has nowhere to hide.
 *
 * Every record and every source appears several times, worded differently,
 * because one phrasing per option only proves that phrasing works. They are
 * written the way someone would say them out loud, short and elliptical forms
 * included, since this app is spoken to rather than typed at.
 *
 * Ported verbatim from the macOS version, where the 102 question run that
 * disproved confidence gating was made.
 */
type Topic = {
  topic: string;
  /** A short word for what answers this, shown beside the suggestions. */
  about: string;
  depth: "record" | "search" | "reasoned";
  /** A record id, a source id, or null where nothing should be narrowed. */
  target: string | null;
  questions: string[];
};

export const TOPICS = corpus as Topic[];

/** The groupings the chips offer, in the order they are shown. */
export const ABOUTS = [...new Set(TOPICS.map((t) => t.about))];
