import prompts from "./prompts.json";

/**
 * What Jev is told when it makes a choice.
 *
 * The wording lives in prompts.json rather than in code, so a meaning can be
 * changed without touching the thing that acts on it. Nothing here matches
 * phrases or keywords against a question: the choice is made by Jev from these
 * descriptions alone.
 */
const text: Record<string, string> = prompts;

export function meaning(key: string): string {
  const found = text[key];
  if (found === undefined) throw new Error(`No prompt for ${key}.`);
  return found;
}

/** Jev's own name for declining. It is an option like any other. */
export const DECLINING = "none_here";
