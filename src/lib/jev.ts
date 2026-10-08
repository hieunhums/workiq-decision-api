import { DECLINING } from "./prompts";

/** One option and the probability Jev gave it. */
export type Odds = { id: string; probability: number };

/** What Jev reports about a choice besides the choice itself. */
export type Certainty = {
  /** Jev's own confidence in the answer, from 0 to 1. */
  confidence: number;
  /** Every option Jev weighed, most likely first. Kept whole so a choice is inspectable. */
  ranked: Odds[];
};

export type Option = { id: string; description: string };

export type Question = {
  key: string;
  instructions: string;
  /** Empty for a yes or no question. */
  options: Option[];
  /**
   * A yes or no question. Jev answers it with the probability of yes, so
   * several small questions can be combined in code rather than forced into
   * one choice.
   */
  yesNo?: boolean;
  /** What is meant by declining, where declining is allowed. */
  noneDescription?: string;
};

type Judgment = {
  /** The chosen option, or null when Jev declined. */
  answer: string | null;
  certainty: Certainty;
};

/** A yes or no question, by key. */
export function yesNo(key: string, instructions: string): Question {
  return { key, instructions, options: [], yesNo: true };
}

export type Judgments = {
  by: Record<string, Judgment>;
  /** The probability of yes for each yes or no question, by key. */
  likely: Record<string, number>;
};

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

class JevError extends Error {}

/**
 * A constrained selector. Jev picks from a fixed set of options and reports how
 * sure it is, which is the whole reason it is here: a free-text model can say
 * anything, and anything cannot be acted on without parsing it back.
 *
 * Every question in one call is independent and travels in one request, so a
 * plan costs a single round trip rather than one per stage.
 */
export class Jev {
  constructor(
    private readonly apiKey: string,
    private readonly model = "jev-1.13.0",
    private readonly timeoutMs = 5000,
  ) {}

  async judge(
    state: Record<string, unknown>,
    questions: Question[],
  ): Promise<Judgments> {
    if (!this.apiKey) throw new JevError("TYPESAFE_API_KEY is not set.");
    const keys = questions.map((q) => q.key);
    if (new Set(keys).size !== keys.length) {
      throw new JevError("Duplicate question keys.");
    }
    for (const question of questions) {
      if (question.yesNo) continue;
      if (question.options.length === 0) {
        throw new JevError(`Question ${question.key} has no options.`);
      }
      if (question.options.some((o) => o.id === DECLINING)) {
        throw new JevError(`Question ${question.key} reuses the declining id.`);
      }
    }

    const wire: Record<string, unknown> = {};
    for (const question of questions) {
      if (question.yesNo) {
        wire[question.key] = { type: "noul", instructions: question.instructions };
        continue;
      }
      const criteria: Record<string, string> = {};
      for (const option of question.options) criteria[option.id] = option.description;
      criteria[DECLINING] =
        question.noneDescription ??
        "Insufficient information, ambiguity, or no applicable offered answer.";
      wire[question.key] = {
        type: "choice",
        instructions: question.instructions,
        criteria,
      };
    }

    const payload = await this.send({ model: this.model, state, questions: wire });
    const answers = payload.answers;
    if (!answers || typeof answers !== "object") {
      throw new JevError("Jev response has no answers.");
    }

    const by: Record<string, Judgment> = {};
    const likely: Record<string, number> = {};
    for (const question of questions) {
      if (question.yesNo) {
        const raw = answers[question.key] as Record<string, unknown> | undefined;
        const p = raw?.noul;
        if (!raw || raw.type !== "noul" || typeof p !== "number" || p < 0 || p > 1) {
          throw new JevError(`Question ${question.key} has no yes or no answer.`);
        }
        likely[question.key] = p;
        continue;
      }
      const raw = answers[question.key] as Record<string, unknown> | undefined;
      if (!raw || raw.type !== "choice") {
        throw new JevError(`Question ${question.key} has no Choice answer.`);
      }
      const valid = new Set([...question.options.map((o) => o.id), DECLINING]);
      const choice = raw.choice;
      if (typeof choice !== "string" || !valid.has(choice)) {
        throw new JevError(`Question ${question.key} selected an unknown option.`);
      }
      const probabilities = raw.probabilities as Record<string, number> | undefined;
      if (!probabilities || Object.keys(probabilities).length !== valid.size) {
        throw new JevError(`Question ${question.key} omitted or added options.`);
      }
      const total = Object.values(probabilities).reduce((a, b) => a + b, 0);
      const confidence = raw.confidence;
      if (
        typeof confidence !== "number" ||
        confidence < 0 ||
        confidence > 1 ||
        Math.abs(total - 1) > 0.03
      ) {
        throw new JevError(`Question ${question.key} returned invalid probabilities.`);
      }
      const ranked: Odds[] = Object.entries(probabilities)
        .map(([id, probability]) => ({ id, probability }))
        .sort((a, b) => b.probability - a.probability);
      by[question.key] = {
        answer: choice === DECLINING ? null : choice,
        certainty: { confidence, ranked },
      };
    }
    return { by, likely };
  }

  private async send(body: unknown): Promise<Record<string, never>> {
    // One retry. This judgment is read-only, so repeating it cannot duplicate
    // an effect.
    let last: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) {
          throw new JevError(`Jev returned HTTP ${response.status}.`);
        }
        return (await response.json()) as Record<string, never>;
      } catch (error) {
        last = error;
      }
    }
    throw new JevError(
      `Jev request failed: ${last instanceof Error ? last.message : String(last)}`,
    );
  }
}
