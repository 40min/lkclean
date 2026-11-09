import { sticker } from "./sticker";
import type { ClassifyResponse, Message, PostPayload, Reason, UiSettings, Verdict } from "./types";

// LinkedIn selectors: classes are obfuscated and move often, so we target
// data-* attributes first (much more stable), then fall back to classes.
const POST_SELECTORS = [
  // new React front end: the feed is an ARIA list, one listitem per post
  '[data-testid="mainFeed"] [role="listitem"]',
  // old Ember front end
  'div[data-id^="urn:li:activity"]',
  'div[data-urn^="urn:li:activity"]',
  "div.feed-shared-update-v2",
];
const TEXT_SELECTORS = [
  '[data-testid="expandable-text-box"]',
  ".update-components-text",
  ".feed-shared-update-v2__description",
  ".feed-shared-inline-show-more-text",
];
// Comments reuse the same text components as posts.
const COMMENTS_SELECTOR = '[data-testid*="commentList"], [componentkey^="replaceableComment"]';
const AUTHOR_SELECTORS = [
  ".update-components-actor__title",
  ".update-components-actor__name",
];

const PROCESSED = "lkcleanProcessed";
// Attribute rather than class: React rewrites className on every render, not the attributes it ignores.
const HIDDEN_ATTR = "data-lkclean-hidden";
const MAX_CONCURRENT = 4;

const REASON_LABEL: Record<Reason, string> = {
  engagement_bait: "engagement bait",
  self_promo: "self-promo",
  off_topic: "off-topic",
  blocked_topic: "blocked topic",
  sponsored: "sponsored",
};

// ---------- extraction ----------

function firstText(root: Element, selectors: string[]): string {
  for (const sel of selectors) {
    for (const el of root.querySelectorAll<HTMLElement>(sel)) {
      if (el.closest(COMMENTS_SELECTOR)) continue;
      let t = el.innerText?.trim() ?? "";
      // Strip the label of the "… more" button included in the text box.
      const more = el.querySelector<HTMLElement>('[data-testid="expandable-text-button"]')?.innerText.trim();
      if (more && t.endsWith(more)) t = t.slice(0, -more.length).trim();
      if (t) return t;
    }
  }
  return "";
}

// \b doesn't work after accented letters: we bound with Unicode lookarounds.
// English labels only ("promoted"); a French-label version was dropped when the
// interface went English-only.
const SPONSORED_RE = /(?<!\p{L})(promoted)(?!\p{L})/u;

// The label can be glued to the author's name in innerText ("Acme CorpPromoted"):
// we also check each small leaf element of the header individually.
function hasSponsoredLabel(el: HTMLElement): boolean {
  let checked = 0;
  for (const leaf of el.querySelectorAll<HTMLElement>("span, p, a, div")) {
    if (leaf.childElementCount > 0) continue;
    if (leaf.closest(`${COMMENTS_SELECTOR}, ${TEXT_SELECTORS.join(",")}`)) continue;
    if (++checked > 40) break;
    const t = (leaf.textContent ?? "").trim().toLowerCase();
    if (t.length <= 30 && SPONSORED_RE.test(t)) return true;
  }
  return false;
}

function authorOf(el: HTMLElement): string {
  const named = firstText(el, AUTHOR_SELECTORS);
  if (named) return named.split("\n")[0] ?? "";
  // New front end: no stable attribute, take the first profile/page link that carries a name.
  for (const a of el.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"], a[href*="/company/"]')) {
    if (a.closest(COMMENTS_SELECTOR)) continue;
    const name = a.innerText.trim().split("\n")[0];
    if (name) return name.slice(0, 80);
  }
  return "";
}

function extract(el: HTMLElement): PostPayload | null {
  // No innerText fallback: without real text (image-only post) we'd judge the post by its buttons.
  const text = firstText(el, TEXT_SELECTORS);
  // Le nouveau front n'expose plus l'URN (les componentkey sont des UUID par rendu) :
  // as a fallback, identify the post by a hash of its text — stable across reloads.
  const id =
    el.getAttribute("data-id") ??
    el.getAttribute("data-urn") ??
    el.querySelector("[data-urn]")?.getAttribute("data-urn") ??
    `h:${hash(text || el.innerText.slice(0, 300))}`;
  const author = authorOf(el);
  // Only look at the header (before the post text), otherwise "I got promoted" would read as an ad.
  const full = el.innerText;
  const textStart = text ? full.indexOf(text.slice(0, 40)) : -1;
  const head = (textStart > 0 ? full.slice(0, textStart) : full.slice(0, 300)).toLowerCase();
  const sponsored = SPONSORED_RE.test(head) || hasSponsoredLabel(el);

  return { id, author, text, sponsored };
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${(h >>> 0).toString(36)}${s.length.toString(36)}`;
}

// ---------- rendering ----------

let ui: UiSettings = {
  enabled: true,
  showKeptReason: true,
  showSticker: true,
  noiseThreshold: 0.7,
  interestThreshold: 0.35,
};

const pct = (x: number) => `${Math.round(x * 100)}%`;

function node<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

// LinkedIn handles dark mode with a class, not prefers-color-scheme: measure the actual background.
function isDarkPage(): boolean {
  const m = getComputedStyle(document.body).backgroundColor.match(/\d+(\.\d+)?/g);
  if (!m || m.length < 3) return false;
  const [r, g, b] = m.map(Number) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 110;
}

/** A verdict in a few words, shared between the post note and the sticker. */
function verdictLabel(v: Verdict): string {
  if (v.hide) return v.reason ? REASON_LABEL[v.reason] : "hidden";
  const match = v.scores?.matches_interests;
  if (match === undefined) return "low noise";
  return v.interest ? `${v.interest} · ${pct(match)}` : `interest ${pct(match)}`;
}

type ChipState = "plain" | "near" | "over";

// Where each score stands relative to the threshold that hides a post: crossed, near (within 15 points), or far.
function scoreStates(v: Verdict): { label: string; value: number; state: ChipState; hint: string }[] {
  const sc = v.scores ?? {};
  const out: ReturnType<typeof scoreStates> = [];
  const m = sc.matches_interests;
  if (m !== undefined) {
    const state = m < ui.interestThreshold ? "over" : m < ui.interestThreshold + 0.15 ? "near" : "plain";
    const which = v.interest ? `Recognized topic: ${v.interest}. ` : "";
    out.push({ label: "interest", value: m, state, hint: `${which}Hides below ${pct(ui.interestThreshold)}` });
  }
  for (const [key, label] of [["engagement_bait", "bait"], ["self_promo", "promo"]] as const) {
    const x = sc[key];
    if (x === undefined) continue;
    const state = x >= ui.noiseThreshold ? "over" : x > ui.noiseThreshold - 0.15 ? "near" : "plain";
    out.push({ label, value: x, state, hint: `Hides at ${pct(ui.noiseThreshold)}` });
  }
  return out;
}

function scoreChips(v: Verdict): HTMLElement[] {
  return scoreStates(v).map(({ label, value, state, hint }) => {
    // On a hidden post, only the score that crossed its threshold stands out.
    const shown = v.hide && state === "near" ? "plain" : state;
    const c = node("span", `lkclean-chip lkclean-chip--${shown}`, `${label} ${pct(value)}`);
    c.title = hint;
    return c;
  });
}

function noteKept(el: HTMLElement, v: Verdict): void {
  if (!ui.showKeptReason || !v.scores || el.querySelector(":scope > .lkclean-note")) return;
  const tight = scoreStates(v).some((x) => x.state === "near");
  const why = v.interest ?? (v.scores.matches_interests !== undefined ? "relevant to you" : "low noise");
  const note = node("div", `lkclean-note${isDarkPage() ? " lkclean--dark" : ""}`);
  const lead = node("span", "lkclean-note__lead");
  lead.append(
    node("span", `lkclean-note__dot${tight ? " lkclean-note__dot--near" : ""}`),
    node("b", "", tight ? "Barely kept" : "Kept by Jev"),
    " · ",
    v.interest ? node("span", "lkclean-note__topic", why) : why,
  );
  if (v.interest) lead.title = `Recognized interest: ${v.interest}`;
  note.append(lead, ...scoreChips(v));
  el.prepend(note);
}

function hidePost(el: HTMLElement, v: Verdict): void {
  if (el.hasAttribute(HIDDEN_ATTR)) return;
  el.querySelector(":scope > .lkclean-note")?.remove();
  const bar = node("div", `lkclean-bar${isDarkPage() ? " lkclean--dark" : ""}`);
  const reason = node("span", "lkclean-bar__reason");
  // verdictLabel() of a hidden post = the reason; the recognized topic is added as a complement.
  reason.append("Post hidden · ", node("b", "", verdictLabel(v)), v.detail ? ` · ${v.detail}` : "");
  if (v.interest) reason.append(" · topic: ", node("span", "lkclean-note__topic", v.interest));
  reason.title = reason.textContent ?? "";
  const btn = node("button", "", "Show");
  btn.type = "button";
  btn.addEventListener("click", () => {
    const shown = el.toggleAttribute(HIDDEN_ATTR) === false;
    btn.textContent = shown ? "Hide again" : "Show";
    bar.classList.toggle("lkclean-bar--shown", shown);
  });
  bar.append(reason, ...scoreChips(v), btn);
  el.prepend(bar);
  el.setAttribute(HIDDEN_ATTR, "");
}

// ---------- pipeline ----------

const queue: HTMLElement[] = [];
let running = 0;
let apiBroken = false;
const attempts = new WeakMap<HTMLElement, number>();
const MAX_ATTEMPTS = 5;
let seen = 0;

const ANY_POST = POST_SELECTORS.join(",");

function enqueue(el: HTMLElement): void {
  // Selectors also match nested containers: only process the outermost.
  const outer = el.parentElement?.closest<HTMLElement>(ANY_POST);
  if (outer) return enqueue(outer);
  if (el.dataset[PROCESSED]) return;
  el.dataset[PROCESSED] = "1";
  if (seen++ === 0) console.info("[lkclean] first post detected");
  lastArrival = Date.now();
  kicks = 0;
  queue.push(el);
  pump();
}

function pump(): void {
  while (running < MAX_CONCURRENT && queue.length > 0) {
    const el = queue.shift()!;
    running++;
    void process(el).finally(() => {
      running--;
      pump();
    });
  }
}

async function process(el: HTMLElement): Promise<void> {
  if (apiBroken || !ui.enabled) return;
  const post = extract(el);
  if (!post) return;

  // React often inserts the container before its content: release the post so
  // a later mutation (the text arriving) queues it again, up to MAX_ATTEMPTS.
  if (!post.text && !post.sponsored) {
    const n = (attempts.get(el) ?? 0) + 1;
    attempts.set(el, n);
    if (n < MAX_ATTEMPTS) delete el.dataset[PROCESSED];
    return;
  }

  let res: ClassifyResponse;
  sticker.start();
  try {
    res = await chrome.runtime.sendMessage<Message, ClassifyResponse>({ type: "classify", post });
  } catch (e) {
    console.warn("[lkclean] message error", e);
    sticker.fail("Extension reloaded: refresh the page.");
    return;
  }
  if (!res.ok) {
    console.warn("[lkclean]", res.error);
    sticker.fail(res.error);
    if (/API key|Jev 40[13]/.test(res.error)) apiBroken = true;
    return;
  }
  console.debug("[lkclean] verdict", post.author.slice(0, 40), res.verdict);
  sticker.settle(post.author, res.verdict, res.meta, verdictLabel(res.verdict));
  if (!el.isConnected) return;
  if (res.verdict.hide) hidePost(el, res.verdict);
  else noteKept(el, res.verdict);
}

// ---------- infinite scroll kick ----------

// LinkedIn loads more when a marker at the bottom of the feed *enters* the
// viewport. If we hide almost everything, the feed becomes so short the marker
// never leaves the screen: no more events, the feed freezes. So we push it
// briefly out of view (a large margin under the last post, invisible because
// below the content) and then let it come back.
const PUSH_ATTR = "data-lkclean-push";
const KICK_IDLE_MS = 1500;
const MAX_KICKS = 8;
let lastArrival = Date.now();
let kicks = 0;

function lastPost(): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>(`[data-lkclean-processed]`);
  return all[all.length - 1] ?? null;
}

function kickInfiniteScroll(): void {
  if (document.hidden || running > 0 || queue.length > 0) return;
  if (!document.querySelector(`[${HIDDEN_ATTR}]`)) return; // we shortened nothing: not our problem
  if (Date.now() - lastArrival < KICK_IDLE_MS * (1 + kicks) || kicks >= MAX_KICKS) return;
  const last = lastPost();
  if (!last || last.getBoundingClientRect().bottom > window.innerHeight * 1.5) return;

  kicks++;
  lastArrival = Date.now();
  last.setAttribute(PUSH_ATTR, "");
  setTimeout(() => {
    last.removeAttribute(PUSH_ATTR);
    // For loaders driven by scroll position rather than by a marker.
    window.dispatchEvent(new Event("scroll"));
    document.dispatchEvent(new Event("scroll"));
  }, 250);
}

// ---------- feed observation ----------

function scan(root: ParentNode): void {
  for (const sel of POST_SELECTORS) {
    root.querySelectorAll<HTMLElement>(sel).forEach(enqueue);
  }
}

function isPost(el: Element): boolean {
  return POST_SELECTORS.some((s) => el.matches(s));
}

const observer = new MutationObserver((mutations) => {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (!(node instanceof HTMLElement)) continue;
      if (isPost(node)) enqueue(node);
      else {
        scan(node);
        // Content added inside a post already seen but still empty.
        const parent = node.closest<HTMLElement>(ANY_POST);
        if (parent) enqueue(parent);
      }
    }
  }
});

// If nothing was detected on the feed, log the page structure (attributes only,
// no content) so the selectors can be re-tuned.
function diagnose(): void {
  if (seen > 0 || !location.pathname.startsWith("/feed")) return;
  const tally = (attr: string) => {
    const m = new Map<string, number>();
    for (const e of document.querySelectorAll(`[${attr}]`)) {
      const k = (e.getAttribute(attr) ?? "").replace(/\d{6,}/g, "N").slice(0, 80);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m].sort((a, b) => b[1] - a[1]).slice(0, 40);
  };
  const KEEP = ["data-view-name", "data-testid", "role", "componentkey", "data-id", "data-urn"];
  const outline = (el: Element, d: number, out: string[]): string[] => {
    const a = KEEP.filter((k) => el.hasAttribute(k)).map((k) => `${k}=${(el.getAttribute(k) ?? "").replace(/\d{6,}/g, "N").slice(0, 70)}`);
    if (a.length) out.push(`${"  ".repeat(Math.min(d, 12))}<${el.tagName.toLowerCase()}> ${a.join(" ")} [txt:${(el as HTMLElement).innerText?.length ?? 0}]`);
    if (out.length < 60) for (const c of el.children) outline(c, d + (a.length ? 1 : 0), out);
    return out;
  };
  const main = document.querySelector("main") ?? document.body;
  // Candidate: the smallest "reasonable" common ancestor of a large text block on the feed.
  const big = [...main.querySelectorAll<HTMLElement>("p, span[dir], div[dir]")].find((e) => e.innerText.length > 200);
  let post: Element | null = big ?? null;
  for (let i = 0; post && i < 12 && post.parentElement && post.parentElement !== main; i++) {
    if (post.parentElement.children.length > 3 && (post as HTMLElement).innerText.length > 300) break;
    post = post.parentElement;
  }
  const report = {
    viewNames: tally("data-view-name"),
    testIds: tally("data-testid"),
    roles: tally("role"),
    componentKeys: tally("componentkey").slice(0, 15),
    firstPost: post ? outline(post, 0, []) : "no candidate",
  };
  console.warn("[lkclean] DIAGNOSTIC — no post detected, copy this block:\n" + JSON.stringify(report, null, 1));
}

async function loadUi(): Promise<void> {
  try {
    const got = await chrome.runtime.sendMessage<Message, UiSettings>({ type: "getUiSettings" });
    if (got) ui = got;
  } catch {
    // service worker unavailable: keep the defaults
  }
  if (ui.enabled && ui.showSticker) sticker.mount();
  else sticker.unmount();
}

async function start(): Promise<void> {
  await loadUi();
  chrome.storage?.onChanged.addListener((_, area) => {
    if (area === "sync") void loadUi();
  });
  scan(document);
  observer.observe(document.body, { childList: true, subtree: true });
  console.info("[lkclean] active");
  setTimeout(diagnose, 6000);
  setInterval(kickInfiniteScroll, 1000);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void start(), { once: true });
} else {
  void start();
}
