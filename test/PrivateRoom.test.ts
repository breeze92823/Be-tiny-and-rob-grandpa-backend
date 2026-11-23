import assert from "assert";
import { matchMaker } from "colyseus";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { __setPrivateKeepAliveForTest } from "../src/rooms/WorldRoom.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

// CrazyGames "Play with friends": the page opens with ?instantMultiplayer=true and the client creates a
// private room (join option `private: true`) that only an invite (its room id) can reach.
describe("private rooms (play with friends)", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());
  afterEach(() => __setPrivateKeepAliveForTest(null));

  it("a room created with private: true is not seated for joinOrCreate and survives its creator briefly", async () => {
    const room = await colyseus.createRoom<WorldState>("world", { private: true });
    await sleep(50);
    const listed = await matchMaker.query({ roomId: room.roomId });
    assert.strictEqual(listed[0]?.private, true);
    assert.strictEqual(room.autoDispose, false);
    const a = await colyseus.connectTo(room, { username: "Ann" });
    await sleep(30);
    assert.strictEqual(room.state.players.size, 1);
    await a.leave();
    await sleep(50);
    // Still alive (keep-alive window), and a friend can still join it by room id.
    const b = await colyseus.connectTo(room, { username: "Bo" });
    await sleep(30);
    assert.ok(room.state.players.has(b.sessionId));
  });

  it("a public room is unaffected", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const listed = await matchMaker.query({ roomId: room.roomId });
    assert.ok(!listed[0]?.private);
  });

  it("an empty private room is disposed after the keep-alive window", async () => {
    __setPrivateKeepAliveForTest(120);
    const room = await colyseus.createRoom<WorldState>("world", { private: true });
    const a = await colyseus.connectTo(room, { username: "Ann" });
    await sleep(30);
    await a.leave();
    await sleep(40);
    assert.ok(matchMaker.getLocalRoomById(room.roomId), "still alive inside the window");
    await sleep(250);
    assert.strictEqual(matchMaker.getLocalRoomById(room.roomId), undefined, "disposed once the window passed");
  });
});
