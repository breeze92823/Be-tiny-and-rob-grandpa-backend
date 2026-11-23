// Keep in step with the client's src/config.js by hand. A room is one lobby ("The Hideout") with 3
// crew pads of 4 players, so it holds 12 players. The deploy workflow sends this as both `roomSize`
// and `seatCap` (the two Boxity docs name different fields; maxClients = room size 2-100).
export const ROOM_MAX_CLIENTS = 12;

// Longest accepted strings.
export const NAME_MAX = 64;
// Profile picture URL (Bloxity `pfp`), relayed so other players can draw it.
export const PFP_MAX_LEN = 512;
// Presence (presence.ts): the Bloxity avatar JSON relayed for the others to draw, and the pose
// bounds: |x|, |z| up to `xz` m, y in yMin..yMax m (the lobby sits at z 1500, the house at the
// origin, walls 16 m high), speed in m/s. The grab point (gx, gy, gz) has the same bounds.
export const AVATAR_MAX_LEN = 3000;
export const POSE_BOUNDS = { xz: 3000, yMin: -50, yMax: 400, speed: 500 };

// Colyseus drops the whole connection for a WebSocket message above this (default 4 KB). The host's
// heist snapshot (`hs`) is up to HS_MAX_BYTES.
export const MAX_PAYLOAD_BYTES = 128 * 1024;

// How long a dropped connection (WiFi blip, backgrounded tab) may reconnect with the same session.
export const RECONNECT_SECONDS = 20;
// A private room (CrazyGames "Play with friends", join option `private: true`) stays alive this long
// with nobody in it, so a reload / reconnect can return to it before friends arrive.
export const PRIVATE_KEEPALIVE_MS = 30_000;

// Upper bounds for saved values, so a forged payload cannot store a bogus number. Generous
// ceilings, not game rules.
export const COINS_MAX = 1e12; // coins on hand
export const STAT_MAX = 1e12; // lifetime stats (counters, coins earned, $ stolen, best haul)
// Upgrades (client UPGRADES): six tracks, levels 0..UPGRADE_MAX.
export const UPGRADE_IDS = ["arms", "grip", "lungs", "feet", "soft", "ninja"] as const;
export type UpgradeId = (typeof UPGRADE_IDS)[number];
export const UPGRADE_MAX = 5;
// Gadgets (client GADGETS): how many of each the player holds, 0..GADGET_MAX. Other ids are dropped.
export const GADGET_IDS = ["marbles", "glue", "banana", "alarm", "smoke", "sleep", "xray", "energy", "bazooka", "extinguisher"] as const;
export type GadgetId = (typeof GADGET_IDS)[number];
export const GADGET_MAX = 99;
// The saved lifetime stats (`stats`). Every one only ever grows (saved with Mongo $max).
export const STAT_KEYS = ["heists", "escapes", "caught", "stolen", "earned", "bestHaul", "jobs"] as const;
export type StatKey = (typeof STAT_KEYS)[number];
// The pure counters among them are whole numbers.
export const STAT_INTS: readonly StatKey[] = ["heists", "escapes", "caught", "jobs"];

// Crew pads (pads.ts): PAD_COUNT pads in the lobby, PAD_SIZE players each. A pad's countdown starts
// at PAD_COUNTDOWN_MS when its first player steps on and drops to PAD_FULL_COUNTDOWN_MS once it is
// full; the room clock checks for due pads every PAD_TICK_MS.
export const PAD_COUNT = 3;
export const PAD_SIZE = 4;
// Every pad launches the same kind of game: NORMAL.
export const PAD_DIFFICULTIES = ["normal", "normal", "normal"] as const;
export type Difficulty = "normal" | "hard" | "nightmare";
export const HEIST_TARGETS: Record<Difficulty, number> = { normal: 1000, hard: 2000, nightmare: 3000 };
export const PAD_COUNTDOWN_MS = 20_000;
export const PAD_FULL_COUNTDOWN_MS = 5_000;
export const PAD_TICK_MS = 250;
// The heist relay: largest accepted payload (its JSON, in bytes) per message, and the most one
// `steal` can add to the crew bank.
export const HS_MAX_BYTES = 24 * 1024; // host snapshot
export const HA_MAX_BYTES = 4 * 1024; // crew action
export const HB_MAX_BYTES = 8 * 1024; // host event
export const STEAL_MAX = 2000;
// A player's zone (PlayerState.zone, server-set): the lobby, or "h<pad index>" while in that pad's heist.
export const ZONE_LOBBY = "lobby";

// Leaderboards (leaderboard.ts): the stats ranked, the saved doc field each one reads, rows per
// board and how often the lists are re-read and re-sent. Stats live under `stats` in the save.
export const LEADERBOARD_FIELDS = {
  escapes: "stats.escapes", // heists escaped from
  earned: "stats.earned", // total coins earned
  bestHaul: "stats.bestHaul", // best crew haul in one heist ($)
  stolen: "stats.stolen", // loot stolen
} as const;
export const LEADERBOARD_STATS = Object.keys(LEADERBOARD_FIELDS) as (keyof typeof LEADERBOARD_FIELDS)[];
export type LeaderboardStat = keyof typeof LEADERBOARD_FIELDS;
export const LEADERBOARD_SIZE = 10;
export const LEADERBOARD_EVERY_MS = 60 * 1000;

// Bloxity (bloxity.ts). The game's slug on bloxity.io (client config.js GAME_SLUG).
export const GAME_SLUG = "be-tiny-and-rob-grandpa";
// The hosted leaderboards, declared to Boxity with every report (the client declares the same ones;
// ids are permanent: lowercase a-z 0-9 _ -, max 32). One per ranked stat.
export const LEADERBOARD_BOARDS: Record<LeaderboardStat, { id: string; label: string; order: "desc"; mode: "best"; format: "number" | "compact"; reset: "none" }> = {
  escapes: { id: "escapes", label: "Escapes", order: "desc", mode: "best", format: "number", reset: "none" },
  earned: { id: "earned", label: "Coins earned", order: "desc", mode: "best", format: "compact", reset: "none" },
  bestHaul: { id: "besthaul", label: "Best haul", order: "desc", mode: "best", format: "compact", reset: "none" },
  stolen: { id: "stolen", label: "Loot stolen", order: "desc", mode: "best", format: "compact", reset: "none" },
};
// Game stats shown on Boxity profiles (max 50 definitions; key a-z 0-9 _, label <= 40 chars) and the
// ceiling per type: a value above it is rejected by Boxity, so values are clamped to it.
export const STAT_CEILINGS = { number: 1e9, seconds: 31_536_000_000, currency: 1e12, percent: 100 } as const;
export const STAT_DEFINITIONS: { key: string; label: string; type: keyof typeof STAT_CEILINGS; field: string }[] = [
  { key: "escapes", label: "Escapes", type: "number", field: "escapes" },
  { key: "coins_earned", label: "Coins earned", type: "currency", field: "earned" },
  { key: "best_haul", label: "Best haul", type: "currency", field: "bestHaul" },
  { key: "loot_stolen", label: "Loot stolen", type: "number", field: "stolen" },
  { key: "heists", label: "Heists", type: "number", field: "heists" },
  { key: "times_caught", label: "Times caught", type: "number", field: "caught" },
  { key: "jobs_done", label: "Jobs done", type: "number", field: "jobs" },
];

// Ids from the client's catalogs (emotes): slugs, so nothing odd is stored or relayed.
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
