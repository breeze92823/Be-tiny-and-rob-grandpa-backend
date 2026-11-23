import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import type { WorldRoom } from "../src/rooms/WorldRoom.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import {
  HA_MAX_BYTES, HB_MAX_BYTES, HS_MAX_BYTES, PAD_COUNTDOWN_MS, PAD_FULL_COUNTDOWN_MS, PAD_SIZE, ROOM_MAX_CLIENTS, STEAL_MAX,
} from "../src/constants.js";
import { __setPadTimingForTest } from "../src/pads.js";
import { sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

type Got = { type: string; msg: any }[];
// A client that records every message it gets (wildcard handler), by type.
async function player(colyseus: ColyseusTestServer<typeof appConfig>, room: any, options: any = {}) {
  const c = await colyseus.connectTo(room, options);
  const got: Got = [];
  c.onMessage("*", (type: any, msg: any) => got.push({ type: String(type), msg }));
  const of = (type: string) => got.filter((g) => g.type === type).map((g) => g.msg);
  return { c, sid: c.sessionId, got, of };
}
type Player = Awaited<ReturnType<typeof player>>;
const big = (bytes: number) => ({ blob: "x".repeat(bytes) });

describe("pads and heists", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  let room: WorldRoom;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => {
    await colyseus.cleanup();
    room = (await colyseus.createRoom<WorldState>("world", {})) as unknown as WorldRoom;
  });
  afterEach(() => __setPadTimingForTest(null));

  const pad = (i: number) => room.state.pads.at(i)!;
  const zone = (p: Player) => room.state.players.get(p.sid)!.zone;
  // Players on pad `i`, launched by driving the pad clock past the countdown.
  async function crewOn(i: number, n: number) {
    const ps: Player[] = [];
    for (let k = 0; k < n; k++) ps.push(await player(colyseus, room, { username: `P${k}` }));
    for (const p of ps) {
      p.c.send("joinPad", { pad: i });
      await sleep(20); // join in order: the first one hosts
    }
    await sleep(60);
    room.tickPads(pad(i).startsAt);
    await sleep(100);
    return ps;
  }

  it("creates 3 pads (all normal) and holds 12 players", async () => {
    assert.strictEqual(room.state.pads.length, 3);
    assert.deepStrictEqual([...room.state.pads].map((p) => p.difficulty), ["normal", "normal", "normal"]);
    assert.deepStrictEqual([...room.state.pads].map((p) => p.target), [1000, 1000, 1000]);
    assert.deepStrictEqual([...room.state.pads].map((p) => [p.index, p.startsAt, p.running, p.members.length]), [[0, 0, false, 0], [1, 0, false, 0], [2, 0, false, 0]]);
    assert.strictEqual(ROOM_MAX_CLIENTS, 12);
    for (let i = 0; i < ROOM_MAX_CLIENTS; i++) await colyseus.connectTo(room as any, {});
    await assert.rejects(colyseus.connectTo(room as any, {}), "a 13th player is refused (the matchmaker opens another room)");
  });

  it("starts the countdown with the first player on a pad and ignores bad pads", async () => {
    const a = await player(colyseus, room);
    const b = await player(colyseus, room);
    const t0 = Date.now();
    a.c.send("joinPad", { pad: 0 });
    await sleep(80);
    const startsAt = pad(0).startsAt;
    assert.ok(startsAt >= t0 + PAD_COUNTDOWN_MS && startsAt <= Date.now() + PAD_COUNTDOWN_MS, "now + 20 s");
    assert.deepStrictEqual([...pad(0).members], [a.sid]);
    b.c.send("joinPad", { pad: 0 });
    await sleep(80);
    assert.deepStrictEqual([...pad(0).members], [a.sid, b.sid]);
    assert.strictEqual(pad(0).startsAt, startsAt, "a second player does not restart it");
    for (const bad of [3, -1, "1", 1.5, null]) b.c.send("joinPad", { pad: bad });
    b.c.send("joinPad", {});
    await sleep(80);
    assert.deepStrictEqual([...pad(0).members], [a.sid, b.sid], "bad pads are ignored");
    // every client sees the pad
    assert.deepStrictEqual([...(b.c.state as any).pads[0].members], [a.sid, b.sid]);
    assert.strictEqual((b.c.state as any).pads[0].startsAt, startsAt);
  });

  it("drops the countdown to 5 s when the pad fills, and refuses a 5th player", async () => {
    const ps: Player[] = [];
    for (let k = 0; k < PAD_SIZE + 1; k++) ps.push(await player(colyseus, room));
    for (const p of ps.slice(0, PAD_SIZE)) p.c.send("joinPad", { pad: 2 });
    await sleep(100);
    assert.strictEqual(pad(2).members.length, PAD_SIZE);
    assert.ok(pad(2).startsAt <= Date.now() + PAD_FULL_COUNTDOWN_MS, "now + 5 s");
    assert.ok(pad(2).startsAt > Date.now() + PAD_FULL_COUNTDOWN_MS - 1000);
    ps[PAD_SIZE].c.send("joinPad", { pad: 2 });
    await sleep(80);
    assert.strictEqual(pad(2).members.length, PAD_SIZE);
    assert.ok(!pad(2).members.includes(ps[PAD_SIZE].sid));
  });

  it("moves a player between pads, and an emptied pad goes idle (leavePad, leaving the room)", async () => {
    const a = await player(colyseus, room);
    const b = await player(colyseus, room);
    a.c.send("joinPad", { pad: 0 });
    await sleep(60);
    a.c.send("joinPad", { pad: 1 });
    await sleep(60);
    assert.deepStrictEqual([[...pad(0).members], pad(0).startsAt], [[], 0]);
    assert.deepStrictEqual([...pad(1).members], [a.sid]);
    b.c.send("joinPad", { pad: 1 });
    await sleep(60);
    const startsAt = pad(1).startsAt;
    a.c.send("leavePad");
    await sleep(60);
    assert.deepStrictEqual([...pad(1).members], [b.sid]);
    assert.strictEqual(pad(1).startsAt, startsAt, "the countdown keeps running while someone waits");
    await b.c.leave();
    await sleep(100);
    assert.deepStrictEqual([[...pad(1).members], pad(1).startsAt], [[], 0], "leaving the room frees the seat");
  });

  it("launches a pad when its countdown runs out: crew, host, zones and heistStart to each member", async () => {
    const lobby = await player(colyseus, room);
    const [a, b, c] = [await player(colyseus, room), await player(colyseus, room), await player(colyseus, room)];
    for (const p of [a, b, c]) {
      p.c.send("joinPad", { pad: 2 });
      await sleep(20);
    }
    await sleep(60);
    const startsAt = pad(2).startsAt;
    room.tickPads(startsAt - 1);
    assert.strictEqual(pad(2).running, false, "not before startsAt");
    room.tickPads(startsAt);
    await sleep(120);
    const p2 = pad(2);
    assert.strictEqual(p2.running, true);
    assert.deepStrictEqual([...p2.crew], [a.sid, b.sid, c.sid]);
    assert.deepStrictEqual([[...p2.members], p2.startsAt, p2.host, p2.money, p2.target], [[], 0, a.sid, 0, 1000]);
    assert.ok(Number.isInteger(p2.seed) && p2.seed >= 0 && p2.seed <= 0xffffffff);
    assert.ok(typeof p2.heistId === "string" && p2.heistId.length > 0);
    assert.deepStrictEqual([zone(a), zone(b), zone(c), zone(lobby)], ["h2", "h2", "h2", "lobby"]);
    for (const p of [a, b, c]) {
      assert.deepStrictEqual(p.of("heistStart"), [
        { pad: 2, heistId: p2.heistId, seed: p2.seed, difficulty: "normal", target: 1000, host: a.sid, crew: [a.sid, b.sid, c.sid] },
      ]);
    }
    assert.deepStrictEqual(lobby.of("heistStart"), [], "only the crew gets it");
    assert.strictEqual((lobby.c.state as any).pads[2].running, true, "the lobby sees the pad running");

    // In a heist: no pads; a running pad takes nobody.
    a.c.send("joinPad", { pad: 0 });
    lobby.c.send("joinPad", { pad: 2 });
    await sleep(80);
    assert.deepStrictEqual([...pad(0).members], []);
    assert.deepStrictEqual([...pad(2).members], []);
  });

  it("launches on the room clock", async () => {
    __setPadTimingForTest({ countdownMs: 300 });
    const a = await player(colyseus, room);
    a.c.send("joinPad", { pad: 1 });
    await sleep(150);
    assert.strictEqual(pad(1).running, false);
    await sleep(600);
    assert.strictEqual(pad(1).running, true);
    assert.strictEqual(a.of("heistStart").length, 1);
    assert.strictEqual(zone(a), "h1");
  });

  it("relays the host snapshot (hs) to the rest of the crew only, never echoed, size-capped", async () => {
    const lobby = await player(colyseus, room);
    const [a, b, c] = await crewOn(0, 3);
    a.c.send("hs", { t: 1, grandpa: [1, 2, 3] });
    b.c.send("hs", { t: 99 }); // not the host
    await sleep(100);
    assert.deepStrictEqual(b.of("hs"), [{ t: 1, grandpa: [1, 2, 3] }]);
    assert.deepStrictEqual(c.of("hs"), [{ t: 1, grandpa: [1, 2, 3] }]);
    assert.deepStrictEqual(a.of("hs"), [], "never echoed to the sender");
    assert.deepStrictEqual(lobby.of("hs"), [], "never outside the crew");
    a.c.send("hs", big(HS_MAX_BYTES));
    a.c.send("hs", [1, 2]);
    a.c.send("hs", "text");
    await sleep(100);
    assert.strictEqual(b.of("hs").length, 1, "oversized and non-object snapshots are dropped");
    a.c.send("hs", big(HS_MAX_BYTES - 100));
    await sleep(100);
    assert.strictEqual(b.of("hs").length, 2, "just under the cap passes");
  });

  it("relays crew actions (ha) to the host only, tagged with the sender", async () => {
    const lobby = await player(colyseus, room);
    const [a, b, c] = await crewOn(1, 3);
    b.c.send("ha", { act: "grab", id: 7, from: "forged" });
    a.c.send("ha", { act: "host-self" });
    lobby.c.send("ha", { act: "outsider" });
    c.c.send("ha", big(HA_MAX_BYTES));
    await sleep(100);
    assert.deepStrictEqual(a.of("ha"), [{ act: "grab", id: 7, from: b.sid }]);
    assert.deepStrictEqual([b.of("ha"), c.of("ha"), lobby.of("ha")], [[], [], []]);
  });

  it("relays host events (hb) to the rest of the crew, from the host only", async () => {
    const [a, b, c] = await crewOn(2, 3);
    a.c.send("hb", { ev: "caught", who: b.sid });
    c.c.send("hb", { ev: "fake" });
    a.c.send("hb", big(HB_MAX_BYTES));
    await sleep(100);
    assert.deepStrictEqual(b.of("hb"), [{ ev: "caught", who: b.sid }]);
    assert.deepStrictEqual(c.of("hb"), [{ ev: "caught", who: b.sid }]);
    assert.deepStrictEqual(a.of("hb"), []);
  });

  it("banks the host's steals, rounded and clamped, and ignores anyone else's", async () => {
    const [a, b] = await crewOn(0, 2);
    a.c.send("steal", { value: 150.4 });
    a.c.send("steal", { value: 1e9 });
    a.c.send("steal", { value: -50 });
    a.c.send("steal", { value: "100" });
    a.c.send("steal", {});
    b.c.send("steal", { value: 500 });
    await sleep(100);
    assert.strictEqual(pad(0).money, 150 + STEAL_MAX);
    assert.strictEqual((b.c.state as any).pads[0].money, 150 + STEAL_MAX, "the crew sees the bank");
  });

  it("sends escaped / leaveHeist players back to the lobby, counting escapes", async () => {
    const lobby = await player(colyseus, room);
    const [a, b, c] = await crewOn(1, 3);
    b.c.send("escaped");
    c.c.send("leaveHeist");
    lobby.c.send("escaped"); // not in a heist: nothing
    await sleep(100);
    const ps = (p: Player) => room.state.players.get(p.sid)!;
    assert.deepStrictEqual([zone(b), ps(b).escapes], ["lobby", 1]);
    assert.deepStrictEqual([zone(c), ps(c).escapes], ["lobby", 0]);
    assert.strictEqual(ps(lobby).escapes, 0);
    assert.deepStrictEqual([...pad(1).crew], [a.sid]);
    assert.strictEqual(pad(1).host, a.sid, "the host stays");
    assert.deepStrictEqual([b.of("hostChanged"), a.of("hostChanged")], [[], []]);
    b.c.send("escaped"); // already out
    await sleep(80);
    assert.strictEqual(ps(b).escapes, 1);
    b.c.send("joinPad", { pad: 0 });
    await sleep(80);
    assert.deepStrictEqual([...pad(0).members], [b.sid], "back in the lobby, pads work again");
  });

  it("hands the heist to the next crew member when the host leaves (hostChanged)", async () => {
    const [a, b, c] = await crewOn(2, 3);
    a.c.send("leaveHeist");
    await sleep(100);
    assert.strictEqual(pad(2).host, b.sid);
    assert.deepStrictEqual(b.of("hostChanged"), [{ pad: 2, host: b.sid }]);
    assert.deepStrictEqual(c.of("hostChanged"), [{ pad: 2, host: b.sid }]);
    assert.deepStrictEqual(a.of("hostChanged"), [], "the one who left is not told");
    // the new host's snapshots now relay; the old one's don't
    b.c.send("hs", { t: 2 });
    a.c.send("hs", { t: 3 });
    await sleep(100);
    assert.deepStrictEqual(c.of("hs"), [{ t: 2 }]);
    // the host leaving the room hands over too
    await b.c.leave();
    await sleep(150);
    assert.strictEqual(pad(2).host, c.sid);
    assert.deepStrictEqual(c.of("hostChanged"), [{ pad: 2, host: b.sid }, { pad: 2, host: c.sid }]);
    assert.deepStrictEqual([...pad(2).crew], [c.sid]);
  });

  it("resets the pad when its crew is empty, and tells the room (heistOver)", async () => {
    const lobby = await player(colyseus, room);
    const [a, b] = await crewOn(2, 2);
    a.c.send("steal", { value: 300 });
    b.c.send("escaped");
    await sleep(80);
    assert.strictEqual(pad(2).running, true, "still running while someone is in");
    a.c.send("escaped");
    await sleep(100);
    const p2 = pad(2);
    assert.deepStrictEqual([p2.running, [...p2.crew], p2.host, p2.money, p2.heistId, p2.startsAt], [false, [], "", 0, "", 0]);
    assert.deepStrictEqual(lobby.of("heistOver"), [{ pad: 2 }]);
    assert.deepStrictEqual(a.of("heistOver"), [{ pad: 2 }]);
    assert.strictEqual((lobby.c.state as any).pads[2].running, false);
    lobby.c.send("joinPad", { pad: 2 });
    await sleep(80);
    assert.deepStrictEqual([...pad(2).members], [lobby.sid], "the pad takes a new crew");
  });

  it("resets the pad when the last crew member leaves the room", async () => {
    const [a] = await crewOn(0, 1);
    assert.strictEqual(pad(0).running, true);
    await a.c.leave();
    await sleep(150);
    assert.deepStrictEqual([pad(0).running, [...pad(0).crew], pad(0).host], [false, [], ""]);
  });
});
