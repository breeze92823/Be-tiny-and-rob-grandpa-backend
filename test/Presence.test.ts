import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { AVATAR_MAX_LEN, POSE_BOUNDS } from "../src/constants.js";
import { sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

describe("presence", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());

  it("takes the pose and look from the join options, and starts in the lobby", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { pose: { x: 3, y: 0.5, z: 1500, yaw: Math.PI, speed: 4 }, avatar: '{"equipped":{}}' });
    await sleep(50);
    const p = room.state.players.get(a.sessionId)!;
    assert.deepStrictEqual([p.x, p.y, p.z, p.speed], [3, 0.5, 1500, 4]);
    assert.ok(Math.abs(Math.abs(p.yaw) - Math.PI) < 1e-5);
    assert.strictEqual(p.avatar, '{"equipped":{}}');
    assert.deepStrictEqual([p.zone, p.escapes], ["lobby", 0]);
  });

  it("bounds poses and looks and relays them to the others", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, {});
    const b = await colyseus.connectTo(room, {});
    await sleep(50);
    a.send("pose", { x: 1e9, y: "high", z: -1e12, yaw: 7, speed: -3 });
    a.send("setAvatar", { avatar: "x".repeat(AVATAR_MAX_LEN + 1) });
    await sleep(100);
    const p = room.state.players.get(a.sessionId)!;
    assert.strictEqual(p.x, POSE_BOUNDS.xz);
    assert.strictEqual(p.y, 0, "a non-number is ignored");
    assert.strictEqual(p.z, -POSE_BOUNDS.xz);
    assert.ok(Math.abs(p.yaw - Math.atan2(Math.sin(7), Math.cos(7))) < 1e-5, "yaw wrapped to -PI..PI");
    assert.strictEqual(p.speed, 0);
    assert.strictEqual(p.avatar, "", "an oversized look is ignored");
    a.send("pose", { y: 1e6 });
    await sleep(80);
    assert.strictEqual(p.y, POSE_BOUNDS.yMax);
    a.send("pose", { y: -1e6 });
    await sleep(80);
    assert.strictEqual(p.y, POSE_BOUNDS.yMin);

    // b's synced copy of the roster sees a's presence.
    const seen = (b.state as any).players.get(a.sessionId);
    assert.strictEqual(seen.x, POSE_BOUNDS.xz);
  });

  it("relays crouch, the grabber arms, held and out, bounded", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, {});
    const b = await colyseus.connectTo(room, {});
    await sleep(60);
    const p = room.state.players.get(a.sessionId)!;
    assert.deepStrictEqual([p.crouch, p.grab, p.held, p.out], [false, false, false, false]);
    a.send("pose", { crouch: true, grab: true, gx: 4, gy: 2.5, gz: -9, held: true, out: true });
    await sleep(80);
    assert.deepStrictEqual([p.crouch, p.grab, p.gx, p.gy, p.gz, p.held, p.out], [true, true, 4, 2.5, -9, true, true]);
    a.send("pose", { crouch: "yes", grab: 1, gx: 1e9, gy: -1e9, gz: "far", held: null, out: 0 });
    await sleep(80);
    assert.deepStrictEqual([p.crouch, p.grab, p.held, p.out], [true, true, true, true], "non-booleans are ignored");
    assert.deepStrictEqual([p.gx, p.gy, p.gz], [POSE_BOUNDS.xz, POSE_BOUNDS.yMin, -9], "the grab point is bounded like a position");
    a.send("pose", { crouch: false, grab: false, held: false, out: false, zone: "h2", escapes: 99 });
    await sleep(80);
    assert.deepStrictEqual([p.crouch, p.grab, p.held, p.out], [false, false, false, false]);
    assert.deepStrictEqual([p.zone, p.escapes], ["lobby", 0], "zone and escapes are server-set only");
    a.send("pose", { grab: true, gx: 7 });
    await sleep(80);
    const seen = (b.state as any).players.get(a.sessionId);
    assert.deepStrictEqual([seen.grab, seen.gx], [true, 7]);
  });

  it("relays the emote, the grounded flag and the verified account id (never a client-sent one)", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { token: "tok-acc5" });
    const g = await colyseus.connectTo(room, { userId: "acc5", token: "forged" });
    await sleep(100);
    const pa = room.state.players.get(a.sessionId)!;
    const pg = room.state.players.get(g.sessionId)!;
    assert.strictEqual(pa.userId, "acc5", "the id Bloxity verified");
    assert.strictEqual(pg.userId, "", "a guest has none, whatever it claims");
    assert.deepStrictEqual([pa.emote, pa.grounded], ["", true]);

    a.send("emote", { id: "emote123" });
    a.send("pose", { x: 1, grounded: false });
    await sleep(80);
    assert.strictEqual(pa.emote, "emote123");
    assert.strictEqual(pa.grounded, false);
    a.send("emote", { id: "Bad Id!" });
    a.send("emote", { id: 7 });
    await sleep(80);
    assert.strictEqual(pa.emote, "emote123", "a malformed id is ignored");
    a.send("emote", { id: "" });
    a.send("pose", { grounded: "yes" });
    await sleep(80);
    assert.strictEqual(pa.emote, "", "an empty id stops it");
    assert.strictEqual(pa.grounded, false, "a non-boolean is ignored");

    // the others' synced copy of the roster sees it
    const seen = (g.state as any).players.get(a.sessionId);
    assert.strictEqual(seen.userId, "acc5");
  });
});
