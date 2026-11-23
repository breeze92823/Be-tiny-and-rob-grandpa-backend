import { MongoClient, type Collection } from "mongodb";

import { LEADERBOARD_FIELDS, LEADERBOARD_STATS, type GadgetId, type StatKey, type UpgradeId } from "./constants.js";

// Bloxity Legion hosting injects MONGODB_URI per game+channel -- an isolated database with
// scoped credentials. A local `npm start` normally has no Mongo reachable, so a missing or
// unreachable URI must degrade to "no persistence" rather than crash the room.

// The persisted client state (what `saveProgress` carries, see sanitize.ts). The client keeps
// nothing in the browser: this document is the player's only save.
export interface PlayerDoc {
  _id: string; // Bloxity user id -- see WorldRoom.ts (guests are never saved)
  username?: string; // display name as of the last save
  coins?: number; // coins on hand (earned by escaping, spent on gadgets / upgrades / Break Free / Revive)
  upgrades?: SavedUpgrades; // upgrade levels 0..UPGRADE_MAX
  gadgets?: SavedGadgets; // gadget id -> how many the player holds
  stats?: SavedStats; // lifetime stats: only ever grow (saved with $max)
  tutorialDone?: boolean;
  prefs?: SavedPrefs; // the in-game Settings window
  lastSeen?: number; // epoch ms of the last activity
  version: number;
  updatedAt: Date;
}

export type SavedUpgrades = Record<UpgradeId, number>;
export type SavedGadgets = Partial<Record<GadgetId, number>>;
// heists played, escapes, times caught, loot stolen, coins earned, best crew haul, jobs done.
export type SavedStats = Record<StatKey, number>;

// The in-game Settings window: music and sound effects on/off.
export interface SavedPrefs {
  music: boolean;
  sfx: boolean;
  lights: boolean;
}

let client: MongoClient | null = null;
let players: Collection<PlayerDoc> | null = null;

export async function connectDb(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn("[db] MONGODB_URI not set -- player progress will not persist");
    return;
  }
  try {
    client = new MongoClient(uri);
    await client.connect();
    // No dbName passed to .db() -- the injected URI already points at this game+channel's database.
    players = client.db().collection<PlayerDoc>("players");
    console.log("[db] connected to MongoDB");
    // The leaderboards sort and count by these (leaderboard.ts).
    for (const stat of LEADERBOARD_STATS) {
      const field = LEADERBOARD_FIELDS[stat];
      players.createIndex({ [field]: -1 }).catch((err) => console.warn(`[db] index on ${field} failed`, err));
    }
  } catch (err) {
    console.warn("[db] connect failed -- player progress will not persist:", err);
    client = null;
    players = null;
  }
}

// Null whenever Mongo is unset/unreachable -- every caller must treat that as "skip persistence".
export function getPlayers(): Collection<PlayerDoc> | null {
  return players;
}

// Test-only seam: exercise the save/load logic against an in-memory fake collection.
export function __setPlayersForTest(fake: Collection<PlayerDoc> | null): void {
  players = fake;
}
