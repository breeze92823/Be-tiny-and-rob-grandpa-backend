import type { Collection } from "mongodb";

import type { PlayerDoc } from "../src/db.js";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Just what WorldRoom calls: findOne() and updateOne() (upsert, $set, $max on dotted paths,
// $setOnInsert), plus the leaderboard's find({ f: { $gt } }).sort({ f: -1 }).limit(n).toArray() and
// countDocuments({ f: { $gt } }). Reads wait for release(), so a test registers its message handlers
// before the load answers.
// A doc's value at a dotted path ("stats.earned"), like Mongo's.
const at = (doc: unknown, path: string): any => path.split(".").reduce<any>((o, k) => (o == null ? o : o[k]), doc);
// Sets a dotted path, creating the objects on the way (copies them, so a seeded doc's nested object is
// never shared with a later read).
function setAt(doc: any, path: string, value: unknown) {
  const keys = path.split(".");
  let o = doc;
  for (const k of keys.slice(0, -1)) o = o[k] = { ...(o[k] ?? {}) };
  o[keys[keys.length - 1]] = value;
}

export function fakePlayers(seed: PlayerDoc[] = []) {
  const docs = new Map<string, PlayerDoc>(seed.map((d) => [d._id, d]));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const fake = {
    docs,
    gate,
    release,
    async findOne(filter: { _id: string }) {
      await gate;
      return docs.get(filter._id) ?? null;
    },
    find(filter: Record<string, { $gt: number }>) {
      const [field, { $gt }] = Object.entries(filter)[0];
      let rows = [...docs.values()].filter((d) => at(d, field) > $gt);
      const cursor = {
        sort(by: Record<string, number>) {
          const [f, dir] = Object.entries(by)[0];
          rows = rows.sort((a, b) => dir * ((at(a, f) ?? 0) - (at(b, f) ?? 0)));
          return cursor;
        },
        limit(n: number) {
          rows = rows.slice(0, n);
          return cursor;
        },
        toArray: async () => rows,
      };
      return cursor;
    },
    async countDocuments(filter: Record<string, { $gt: number }>) {
      const [field, { $gt }] = Object.entries(filter)[0];
      return [...docs.values()].filter((d) => at(d, field) > $gt).length;
    },
    async updateOne(filter: { _id: string }, update: any, options: any) {
      const existing = docs.get(filter._id);
      if (!existing && !options?.upsert) return { modifiedCount: 0 };
      const next: any = { ...(existing ?? { _id: filter._id, ...(update.$setOnInsert ?? {}) }) };
      for (const [k, v] of Object.entries(update.$set ?? {})) setAt(next, k, v);
      for (const [k, v] of Object.entries(update.$max ?? {})) setAt(next, k, Math.max(at(next, k) ?? -Infinity, v as number));
      docs.set(filter._id, next);
      return { modifiedCount: 1 };
    },
  };
  return fake as unknown as Collection<PlayerDoc> & { docs: Map<string, PlayerDoc>; gate: Promise<void>; release: () => void };
}
