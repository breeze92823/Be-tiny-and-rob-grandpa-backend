import { COINS_MAX, GADGET_IDS, GADGET_MAX, STAT_INTS, STAT_KEYS, STAT_MAX, UPGRADE_IDS, UPGRADE_MAX } from "./constants.js";
import type { PlayerDoc, SavedGadgets, SavedPrefs, SavedStats, SavedUpgrades } from "./db.js";

export function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
export function clampNum(v: number, max: number): number {
  return Math.min(max, Math.max(0, v));
}
export function clampInt(v: number, max: number, min = 0): number {
  return Math.min(max, Math.max(min, Math.floor(v)));
}
function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// Upgrade levels: every track, a whole 0..UPGRADE_MAX (a missing / bad one is 0).
function sanitizeUpgrades(raw: unknown): SavedUpgrades {
  const u = isObject(raw) ? raw : {};
  return Object.fromEntries(UPGRADE_IDS.map((id) => [id, finite(u[id]) ? clampInt(u[id], UPGRADE_MAX) : 0])) as SavedUpgrades;
}

// Gadget counts: known gadget ids only (others dropped), whole 0..GADGET_MAX.
function sanitizeGadgets(raw: unknown): SavedGadgets {
  const g = isObject(raw) ? raw : {};
  const out: SavedGadgets = {};
  for (const id of GADGET_IDS) if (finite(g[id])) out[id] = clampInt(g[id], GADGET_MAX);
  return out;
}

// Lifetime stats: non-negative, bounded, the counters whole. Every key is present (0 when missing or
// bad); WorldRoom saves them with $max, so a 0 (or any lower value) never lowers a stored stat.
function sanitizeStats(raw: unknown): SavedStats {
  const s = isObject(raw) ? raw : {};
  return Object.fromEntries(
    STAT_KEYS.map((k) => [k, !finite(s[k]) ? 0 : STAT_INTS.includes(k) ? clampInt(s[k], STAT_MAX) : clampNum(s[k], STAT_MAX)]),
  ) as SavedStats;
}

// The game is client-authoritative -- no server-side gameplay validation. What IS enforced:
// shape and bounds, so a malformed payload can never corrupt this player's own Mongo document.
// A forged number can only ever affect the sender's own save. Fields left out stay out (they are
// kept as stored). Idempotent: the same function cleans the doc read back from Mongo.
export function sanitizeProgress(raw: unknown): Partial<PlayerDoc> | null {
  if (!isObject(raw)) return null;
  const out: Partial<PlayerDoc> = {};

  if (finite(raw.coins)) out.coins = clampNum(raw.coins, COINS_MAX);
  if (raw.upgrades !== undefined) out.upgrades = sanitizeUpgrades(raw.upgrades);
  if (raw.gadgets !== undefined) out.gadgets = sanitizeGadgets(raw.gadgets);
  if (raw.stats !== undefined) out.stats = sanitizeStats(raw.stats);
  if (typeof raw.tutorialDone === "boolean") out.tutorialDone = raw.tutorialDone;
  if (raw.prefs !== undefined) out.prefs = sanitizePrefs(raw.prefs);
  if (finite(raw.lastSeen)) out.lastSeen = clampInt(raw.lastSeen, Date.now() + 10 * 60 * 1000);
  return out;
}

// The in-game Settings window (music / sound effects / light effects on or off): booleans only, true by default.
export function sanitizePrefs(raw: unknown): SavedPrefs {
  const p = isObject(raw) ? raw : {};
  return { music: p.music !== false, sfx: p.sfx !== false, lights: p.lights !== false };
}

// Stats merged the way Mongo's $max merges them: each one keeps the higher of the two.
export function maxStats(a: SavedStats | undefined, b: SavedStats | undefined): SavedStats | undefined {
  if (!a || !b) return b ?? a;
  return Object.fromEntries(STAT_KEYS.map((k) => [k, Math.max(a[k] ?? 0, b[k] ?? 0)])) as SavedStats;
}
