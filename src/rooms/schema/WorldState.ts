import { schema, t, type SchemaType } from "@colyseus/schema";

// The live roster: who is in the room, and the lobby's crew pads. Durable progress lives in Mongo
// (src/db.ts). To sync something new about a player, add a field here and accept it in a WorldRoom
// message.
export const PlayerState = schema(
  {
    username: t.string().default(""), // Bloxity displayName/username (verified players) or the guest's own name
    signedIn: t.boolean().default(false), // has a Bloxity id: only signed-in players are saved
    pfp: t.string().default(""), // Bloxity profile picture URL ("" = none)
    // The verified Bloxity account id ("" = guest). Public on purpose: Boxity's chat messages carry the
    // sender's userId, which is how a client finds the character a bubble belongs to.
    userId: t.string().default(""),
    avatar: t.string().default(""), // Bloxity look JSON { equipped, proportions, skin }, "" = default
    emote: t.string().default(""), // the portal emote this player is playing ("" = none)
    // Presence (presence.ts `pose`): what the others draw in the world.
    x: t.float64().default(0), // feet position, m
    y: t.float64().default(0),
    z: t.float64().default(0),
    yaw: t.float32().default(0), // heading, rad (PI = facing north, -Z)
    speed: t.float32().default(0), // m/s
    grounded: t.boolean().default(true), // on the floor (false in the air), for the others' animation
    crouch: t.boolean().default(false), // sneaking
    grab: t.boolean().default(false), // grabber arms out, stretched to the grab point
    gx: t.float64().default(0), // grab point, m (drawn as stretchy arms)
    gy: t.float64().default(0),
    gz: t.float64().default(0),
    held: t.boolean().default(false), // in Grandpa's hand
    out: t.boolean().default(false), // out of the heist (caged too long): spectating
    // Server-set only (pads.ts): "lobby", or "h<pad index>" while in that pad's heist. Clients draw
    // only the players in their own zone.
    zone: t.string().default("lobby"),
    escapes: t.uint16().default(0), // heists escaped this session (server-counted `escaped`)
  },
  "PlayerState",
);
export type PlayerState = SchemaType<typeof PlayerState>;

// One crew pad (a giant bottle cap in the lobby) and the heist its crew is running (pads.ts).
export const PadState = schema(
  {
    index: t.uint8().default(0), // 0..PAD_COUNT-1
    difficulty: t.string().default("normal"), // "normal" (every pad); the type allows hard | nightmare
    members: t.array("string"), // session ids waiting on the pad (max PAD_SIZE)
    startsAt: t.float64().default(0), // server epoch ms the heist launches at (0 = idle)
    running: t.boolean().default(false), // a heist is in progress
    crew: t.array("string"), // session ids in the heist
    host: t.string().default(""), // session id running Grandpa + the physics for the crew
    seed: t.uint32().default(0), // the heist's random seed (loot, jobs, Grandpa)
    money: t.float64().default(0), // the crew bank ($ stolen so far, host-reported `steal`)
    target: t.uint32().default(0), // the bank needed to escape (by difficulty)
    heistId: t.string().default(""), // id of the running heist ("" = none)
  },
  "PadState",
);
export type PadState = SchemaType<typeof PadState>;

export const WorldState = schema(
  {
    players: t.map(PlayerState), // keyed by sessionId
    pads: t.array(PadState), // PAD_COUNT pads, created with the room
  },
  "WorldState",
);
export type WorldState = SchemaType<typeof WorldState>;
