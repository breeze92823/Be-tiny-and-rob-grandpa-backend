import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __setPlayersForTest } from "../src/db.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

const stats = { heists: 4, escapes: 3, caught: 1, stolen: 2400, earned: 1800, bestHaul: 1100, jobs: 7 };

describe("progress", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());
  afterEach(() => __setPlayersForTest(null));

  it("sends a saved player their progress and saves what they send back", async () => {
    const fake = fakePlayers([
      {
        _id: "u1", coins: 5000, upgrades: { arms: 2, grip: 1, lungs: 0, feet: 0, soft: 0, ninja: 3 }, gadgets: { marbles: 4 }, stats,
        tutorialDone: true, version: 1, updatedAt: new Date(),
      },
    ]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { token: "tok-u1", username: "Ann" });
    let got: any = null;
    c.onMessage("progress", (m: any) => (got = m));
    c.onMessage("leaderboard", () => {});
    fake.release();
    await sleep(150);
    assert.strictEqual(got?.coins, 5000);
    assert.strictEqual(got?.upgrades.ninja, 3);
    assert.deepStrictEqual(got?.gadgets, { marbles: 4 });
    assert.deepStrictEqual(got?.stats, stats);
    assert.strictEqual(got?.tutorialDone, true);
    assert.ok(typeof got?.serverTime === "number");

    c.send("saveProgress", { coins: 7000, gadgets: { marbles: 3, smoke: 1, rocket: 9 }, upgrades: { arms: 3 }, prefs: { music: false }, hack: 1 });
    await sleep(150);
    const doc = fake.docs.get("u1")! as any;
    assert.strictEqual(doc.coins, 7000);
    assert.deepStrictEqual(doc.gadgets, { marbles: 3, smoke: 1 });
    assert.strictEqual(doc.upgrades.arms, 3);
    assert.deepStrictEqual(doc.prefs, { music: false, sfx: true, lights: true });
    assert.strictEqual(doc.tutorialDone, true, "fields a save leaves out are kept");
    assert.deepStrictEqual(doc.stats, stats, "stats a save leaves out are kept");
    assert.strictEqual(doc.username, "u1", "the name is the verified account's, not the one the client sent");
    assert.ok(!("hack" in doc));
  });

  it("never lowers a lifetime stat (saved with $max)", async () => {
    const fake = fakePlayers([{ _id: "u4", stats, version: 1, updatedAt: new Date() }]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { token: "tok-u4" });
    c.onMessage("progress", () => {});
    c.onMessage("leaderboard", () => {});
    fake.release();
    await sleep(150);
    c.send("saveProgress", { stats: { heists: 5, escapes: 0, caught: 0, stolen: 100, earned: 2500, bestHaul: 900, jobs: 7 } });
    await sleep(150);
    assert.deepStrictEqual(fake.docs.get("u4")!.stats, { heists: 5, escapes: 3, caught: 1, stolen: 2400, earned: 2500, bestHaul: 1100, jobs: 7 });
    c.send("saveProgress", { stats: {} });
    await sleep(150);
    assert.strictEqual(fake.docs.get("u4")!.stats!.heists, 5, "an empty stats object lowers nothing");
  });

  it("creates a new account's save and never saves a guest", async () => {
    const fake = fakePlayers();
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { token: "tok-new1" });
    let none = false;
    c.onMessage("noProgress", () => (none = true));
    c.onMessage("leaderboard", () => {});
    fake.release();
    await sleep(150);
    assert.ok(none);
    c.send("saveProgress", { coins: 10, stats: { heists: 1 } });
    await sleep(150);
    assert.strictEqual(fake.docs.get("new1")?.coins, 10);
    assert.strictEqual(fake.docs.get("new1")?.stats?.heists, 1);
    assert.strictEqual(fake.docs.get("new1")?.version, 1);

    const guest = await colyseus.connectTo(room, {});
    guest.onMessage("noProgress", () => {});
    guest.onMessage("leaderboard", () => {});
    await sleep(150);
    guest.send("saveProgress", { coins: 99 });
    await sleep(150);
    assert.strictEqual(fake.docs.size, 1, "a guest is never written");
    assert.strictEqual(room.state.players.get(guest.sessionId)?.signedIn, false);
  });

  it("ignores a save sent before the load answered", async () => {
    const fake = fakePlayers([{ _id: "u5", coins: 900, version: 1, updatedAt: new Date() }]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { token: "tok-u5" });
    c.onMessage("progress", () => {});
    c.onMessage("leaderboard", () => {});
    c.send("saveProgress", { coins: 0 });
    await sleep(100);
    fake.release();
    await sleep(150);
    assert.strictEqual(fake.docs.get("u5")!.coins, 900);
  });

  it("loads the new identity when a guest signs in mid-session", async () => {
    const fake = fakePlayers([{ _id: "u2", coins: 42, version: 1, updatedAt: new Date() }]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, {});
    let got: any = null;
    c.onMessage("noProgress", () => {});
    c.onMessage("progress", (m: any) => (got = m));
    c.onMessage("leaderboard", () => {});
    fake.release();
    await sleep(150);
    c.send("identify", { token: "tok-u2", username: "Bea" });
    await sleep(150);
    assert.strictEqual(got?.coins, 42);
    assert.strictEqual(room.state.players.get(c.sessionId)?.signedIn, true);
  });

  it("keeps saving off when the save could not be read", async () => {
    const fake = fakePlayers([{ _id: "u3", coins: 1e9, version: 1, updatedAt: new Date() }]);
    (fake as any).findOne = async () => {
      await fake.gate;
      throw new Error("down");
    };
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { token: "tok-u3" });
    let failed = false;
    c.onMessage("serverError", () => (failed = true));
    fake.release();
    await sleep(150);
    assert.ok(failed);
    c.send("saveProgress", { coins: 0 });
    await sleep(150);
    assert.strictEqual(fake.docs.get("u3")!.coins, 1e9, "the unread save is never overwritten");
  });

  it("evicts an older live session on the same account (close code 4000)", async () => {
    const fake = fakePlayers([{ _id: "u6", coins: 1, version: 1, updatedAt: new Date() }]);
    __setPlayersForTest(fake);
    fake.release();
    const room = await colyseus.createRoom<WorldState>("world", {});
    const first = await colyseus.connectTo(room, { token: "tok-u6" });
    first.onMessage("progress", () => {});
    first.onMessage("leaderboard", () => {});
    let closed: number | null = null;
    first.onLeave((code: number) => (closed = code));
    await sleep(100);
    const second = await colyseus.connectTo(room, { token: "tok-u6" });
    second.onMessage("progress", () => {});
    second.onMessage("leaderboard", () => {});
    await sleep(200);
    assert.strictEqual(closed, 4000);
    assert.ok(!room.state.players.has(first.sessionId));
    assert.strictEqual(room.state.players.get(second.sessionId)?.userId, "u6");
  });
});
