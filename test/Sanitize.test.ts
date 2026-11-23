import assert from "assert";

import { COINS_MAX, GADGET_MAX, STAT_MAX, UPGRADE_MAX } from "../src/constants.js";
import { maxStats, sanitizeProgress } from "../src/sanitize.js";

const zeroStats = { heists: 0, escapes: 0, caught: 0, stolen: 0, earned: 0, bestHaul: 0, jobs: 0 };

describe("sanitizeProgress", () => {
  it("rejects non-objects and bounds the coins", () => {
    assert.strictEqual(sanitizeProgress(null), null);
    assert.strictEqual(sanitizeProgress([1]), null);
    assert.strictEqual(sanitizeProgress("x"), null);
    const out = sanitizeProgress({ coins: 1e40, lastSeen: NaN, hack: "x", gems: 5 })!;
    assert.strictEqual(out.coins, COINS_MAX);
    assert.strictEqual(out.lastSeen, undefined);
    assert.ok(!("hack" in out));
    assert.ok(!("gems" in out), "no premium currency in the save");
    assert.strictEqual(sanitizeProgress({ coins: -5 })!.coins, 0);
    assert.strictEqual(sanitizeProgress({ coins: "9" })!.coins, undefined);
    assert.strictEqual(sanitizeProgress({ coins: 12.5 })!.coins, 12.5);
  });

  it("keeps every upgrade a whole level 0..5", () => {
    const out = sanitizeProgress({ upgrades: { arms: 3.9, grip: 99, lungs: -1, feet: "2", soft: 5, laser: 4 } })!;
    assert.deepStrictEqual(out.upgrades, { arms: 3, grip: UPGRADE_MAX, lungs: 0, feet: 0, soft: 5, ninja: 0 });
    assert.deepStrictEqual(sanitizeProgress({ upgrades: 7 })!.upgrades, { arms: 0, grip: 0, lungs: 0, feet: 0, soft: 0, ninja: 0 });
  });

  it("keeps known gadget counts, whole 0..99, and drops unknown ids", () => {
    const out = sanitizeProgress({ gadgets: { marbles: 3, glue: 1e6, banana: -2, xray: 1.7, bazooka: "1", rocket: 5 } })!;
    assert.deepStrictEqual(out.gadgets, { marbles: 3, glue: GADGET_MAX, banana: 0, xray: 1 });
    assert.deepStrictEqual(sanitizeProgress({ gadgets: [1, 2] })!.gadgets, {});
  });

  it("bounds the lifetime stats (counters whole, all non-negative)", () => {
    const out = sanitizeProgress({ stats: { heists: 10.9, escapes: -1, caught: "x", stolen: 1234.5, earned: 1e20, bestHaul: 850, jobs: 4, extra: 9 } })!;
    assert.deepStrictEqual(out.stats, { heists: 10, escapes: 0, caught: 0, stolen: 1234.5, earned: STAT_MAX, bestHaul: 850, jobs: 4 });
    assert.deepStrictEqual(sanitizeProgress({ stats: null })!.stats, zeroStats);
  });

  it("keeps the tutorial flag and the Settings prefs as booleans (prefs on unless explicitly off)", () => {
    assert.strictEqual(sanitizeProgress({ tutorialDone: true })!.tutorialDone, true);
    assert.strictEqual(sanitizeProgress({ tutorialDone: "yes" })!.tutorialDone, undefined);
    assert.deepStrictEqual(sanitizeProgress({ prefs: { music: false, sfx: "x" } })!.prefs, { music: false, sfx: true, lights: true });
    assert.deepStrictEqual(sanitizeProgress({ prefs: 5 })!.prefs, { music: true, sfx: true, lights: true });
    assert.strictEqual(sanitizeProgress({})!.prefs, undefined);
  });

  it("leaves out the fields a save leaves out", () => {
    assert.deepStrictEqual(sanitizeProgress({ coins: 5 }), { coins: 5 });
  });

  it("is idempotent, so a doc read back from Mongo comes out the same", () => {
    const once = sanitizeProgress({
      coins: 500, upgrades: { arms: 2, ninja: 5 }, gadgets: { smoke: 2, sleep: 0 }, stats: { heists: 3, earned: 1200, bestHaul: 900 },
      tutorialDone: true, prefs: { music: false }, lastSeen: 1000,
    })!;
    assert.deepStrictEqual(sanitizeProgress(once), once);
  });

  it("merges stats like Mongo's $max", () => {
    const a = { ...zeroStats, heists: 5, earned: 100 };
    const b = { ...zeroStats, heists: 2, earned: 300 };
    assert.deepStrictEqual(maxStats(a, b), { ...zeroStats, heists: 5, earned: 300 });
    assert.deepStrictEqual(maxStats(undefined, b), b);
    assert.deepStrictEqual(maxStats(a, undefined), a);
  });
});
