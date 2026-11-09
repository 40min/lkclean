import type { Provider } from "./types";

// Minimal client for the System One endpoint — TypeSafe direct or via
// OpenRouter, as chosen by the user (see `Provider` in ./types).
// Ref.: https://docs.typesafe.ai/api + https://openrouter.ai/docs/guides/community/jev-tutorial

export type NoulQuestion = {
  type: "noul";
  instructions: string;
  criteria?: { true?: string; false?: string };
};
export type ChoiceQuestion = {
  type: "choice";
  instructions: string;
  criteria: Record<string, string | null>;
};
export type ScoreQuestion = {
  type: "score";
  instructions: string;
  criteria: string[];
};
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export type NoulAnswer = { type: "noul"; noul: number };
export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};
export type ScoreAnswer = {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
};
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

type AnswerFor<Q extends Question> = Q extends NoulQuestion
  ? NoulAnswer
  : Q extends ChoiceQuestion
    ? ChoiceAnswer
    : ScoreAnswer;

export interface JevResponse<Q extends Record<string, Question>> {
  model: string;
  answers: { [K in keyof Q]: AnswerFor<Q[K]> };
  usage: { input_tokens: number; output_tokens: number };
}

// Completeness is compiler-enforced: adding a value to the Provider union
// without an endpoint here fails typecheck.
const ENDPOINTS: Record<Provider, string> = {
  typesafe: "https://api.typesafe.ai/v1/systemone",
  openrouter: "https://openrouter.ai/api/v1/systemone",
};
const TIMEOUT_MS = 10_000;
const RETRYABLE_STATUSES = new Set([429, 502, 503, 524, 529]);

export async function askJev<Q extends Record<string, Question>>(
  apiKey: string,
  provider: Provider,
  model: string,
  state: unknown,
  questions: Q,
  attempt = 0,
): Promise<JevResponse<Q>> {
  const res = await fetch(ENDPOINTS[provider], {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ state, model, questions }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (RETRYABLE_STATUSES.has(res.status) && attempt < 3) {
    const retryAfter = Number(res.headers.get("retry-after"));
    const delay =
      retryAfter > 0 ? Math.min(retryAfter * 1000, 10_000) : 400 * 2 ** attempt;
    await new Promise((r) => setTimeout(r, delay));
    return askJev(apiKey, provider, model, state, questions, attempt + 1);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Jev ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as JevResponse<Q>;
}
