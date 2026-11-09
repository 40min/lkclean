// Client minimal pour l'endpoint System One — TypeSafe direct OU via OpenRouter,
// au choix de l'utilisateur (voir `Provider` ci-dessous).
// Réf. : https://docs.typesafe.ai/api et https://openrouter.ai/docs/guides/community/jev-tutorial

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

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
// TODO(learner) [Étape 1 / ancre 1b — REVISED: dual provider]: replace the single
// const with a map + derived type, and give askJev() a first parameter:
//
//   const ENDPOINTS = {
//     typesafe: "https://api.typesafe.ai/v1/systemone",
//     openrouter: "https://openrouter.ai/api/v1/systemone",
//   } as const;
//   export type Provider = keyof typeof ENDPOINTS;
//
// In askJev(...): add `provider: Provider` first, read ENDPOINTS[provider], and
// thread the value in from background.ts (ancre 6 there). Both endpoints serve
// the identical { model, state, questions } body — your Step 0 curl proved it.
const TIMEOUT_MS = 10_000;

export async function askJev<Q extends Record<string, Question>>(
  apiKey: string,
  model: string,
  state: unknown,
  questions: Q,
  attempt = 0,
): Promise<JevResponse<Q>> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ state, model, questions }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if ((res.status === 429 || res.status === 529) && attempt < 3) {
    // TODO(learner) [Étape 1 / ancre ... — retry]: with both providers served by
    // this one function, widen to `res.status >= 500 || res.status === 429`
    // (OpenRouter adds 502/503/524 retryables; TypeSafe's 529 is already >= 500).
    // First answer for yourself: is there any 5xx in OpenRouter's table that is
    // NOT transient? (500 "Internal Server Error" — think about what retrying it
    // hides.)
    // API reference: https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request
    const retryAfter = Number(res.headers.get("retry-after"));
    const delay = retryAfter > 0 ? Math.min(retryAfter * 1000, 10_000) : 400 * 2 ** attempt;
    await new Promise((r) => setTimeout(r, delay));
    return askJev(apiKey, model, state, questions, attempt + 1);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Jev ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as JevResponse<Q>;
}
