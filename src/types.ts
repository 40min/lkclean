/** Where Jev is served from; drives the endpoint map in jev.ts. */
export type Provider = "typesafe" | "openrouter";

export interface Settings {
  enabled: boolean;
  /** TypeSafe direct API key. */
  apiKey: string;
  /**
   * v1 stance: the model id does NOT follow a provider switch; the user keeps
   * it up to date (the sticker shows which model actually served the verdicts).
   * Auto-suggesting a model per provider = stretch goal.
   */
  model: string;
  provider: Provider;
  openrouterApiKey: string;
  /** One interest per line, e.g. "applied AI", "product management" */
  interests: string[];
  /** Topics to always hide, e.g. "job offers", "crypto" */
  blocked: string[];
  /** Hide if P(matches interests) < threshold */
  interestThreshold: number;
  /** Hide if P(engagement bait / self-promo) > threshold */
  noiseThreshold: number;
  /** Never hide a post shorter than N characters (often an image alone) */
  minChars: number;
  hideSponsored: boolean;
  /** Show, on kept posts, why Jev let them pass */
  showKeptReason: boolean;
  /** Floating "Jev activity" sticker on the LinkedIn page */
  showSticker: boolean;
}

/** Subset of the settings exposed to the content script (never the API key). */
export type UiSettings = Pick<
  Settings,
  | "enabled"
  | "showKeptReason"
  | "showSticker"
  | "noiseThreshold"
  | "interestThreshold"
>;

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  apiKey: "",
  /** v1 stance: the model id does NOT follow the provider switch; verified
   *  after each change. Fixing grudges mechanically = stretch goal. */
  model: "jev-latest",
  provider: "typesafe",
  openrouterApiKey: "",
  interests: [],
  blocked: [],
  interestThreshold: 0.35,
  noiseThreshold: 0.7,
  minChars: 40,
  hideSponsored: true,
  showKeptReason: true,
  showSticker: true,
};

export type Reason =
  | "engagement_bait"
  | "self_promo"
  | "off_topic"
  | "blocked_topic"
  | "sponsored";

export interface Verdict {
  hide: boolean;
  reason?: Reason;
  detail?: string;
  /** The user's interest the post matches most, if any */
  interest?: string;
  /** raw scores, useful for debugging */
  scores?: Record<string, number>;
}

export interface PostPayload {
  id: string;
  author: string;
  text: string;
  sponsored: boolean;
}

/** What the verdict cost: powers the activity sticker. */
export interface CallMeta {
  /** false when no Jev call was needed (sponsored, too short, filtering off) */
  evaluated: boolean;
  cached: boolean;
  ms: number;
  inputTokens: number;
  model?: string;
}

export type Message =
  | { type: "classify"; post: PostPayload }
  | { type: "getUiSettings" }
  | { type: "openOptions" };

export type ClassifyResponse =
  | { ok: true; verdict: Verdict; meta: CallMeta }
  | { ok: false; error: string };
