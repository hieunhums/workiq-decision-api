"use client";

import { useState } from "react";
import { ABOUTS, TOPICS } from "@/lib/questions";
import styles from "./ui.module.css";

/** A spread across the lanes, so the first few tries show the cost range. */
const FEATURED = [
  "Who is my manager?",
  "What meetings do I have today?",
  "What unread mail is waiting for me?",
  "Who is the expert on TypeSpec?",
  "What did the team post in Teams about the release?",
  "What are my priorities this quarter?",
];

const COST: Record<string, string> = {
  record: "~1s",
  search: "~10s",
  reasoned: "~50s",
  web: "<1s",
};

/**
 * Public web questions. The model sends these to search_web on its own; they
 * are here so it is obvious the web is there at all.
 */
const WEB = [
  "What's the weather in Singapore today?",
  "How is Microsoft stock doing?",
  "What's the latest AI news this week?",
];

const depthOf = (question: string) =>
  TOPICS.find((t) => t.questions.includes(question))?.depth ?? "record";

/**
 * What can be asked. Six to start with, spread across the lanes, and the full
 * corpus a click away. The full list is the same one routing is measured
 * against, so anything offered here that routes badly shows up in the check.
 */
export function Suggestions({
  onPick,
  web,
}: {
  onPick: (question: string) => void;
  web: boolean;
}) {
  const [all, setAll] = useState(false);

  return (
    <div className={styles.suggestions}>
      <p className={styles.shelfName}>Your work, through Work IQ</p>
      <div className={styles.featured}>
        {FEATURED.map((question) => (
          <Pick key={question} question={question} depth={depthOf(question)} onPick={onPick} />
        ))}
      </div>

      {web && (
        <>
          <p className={styles.shelfName}>The public web, through Web IQ</p>
          <div className={styles.featured}>
            {WEB.map((question) => (
              <Pick key={question} question={question} depth="web" onPick={onPick} />
            ))}
          </div>
        </>
      )}

      <button className={styles.browse} onClick={() => setAll(!all)}>
        {all ? "Fewer" : `Browse all ${TOPICS.length} topics`}
      </button>

      {all && (
        <div className={styles.catalogue}>
          {ABOUTS.map((about) => (
            <div key={about} className={styles.shelf}>
              <p className={styles.shelfName}>{about}</p>
              {TOPICS.filter((t) => t.about === about).map((topic) => (
                <Pick
                  key={topic.topic}
                  question={topic.questions[0]}
                  depth={topic.depth}
                  topic={topic.topic}
                  onPick={onPick}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Pick({
  question,
  depth,
  topic,
  onPick,
}: {
  question: string;
  depth: string;
  topic?: string;
  onPick: (question: string) => void;
}) {
  return (
    <button className={styles.pick} data-depth={depth} onClick={() => onPick(question)}>
      <span className={styles.pickText}>
        {topic && <span className={styles.pickTopic}>{topic}</span>}
        {question}
      </span>
      <span className={styles.pickCost}>
        <span className={styles.receiptDot} />
        {COST[depth]}
      </span>
    </button>
  );
}
