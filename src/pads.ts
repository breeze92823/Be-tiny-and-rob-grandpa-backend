import { randomBytes } from "node:crypto";

import {
  HEIST_TARGETS, PAD_COUNT, PAD_COUNTDOWN_MS, PAD_DIFFICULTIES, PAD_FULL_COUNTDOWN_MS, PAD_SIZE, STEAL_MAX, ZONE_LOBBY,
} from "./constants.js";
import { HeistState, PadState, type WorldState } from "./rooms/schema/WorldState.js";

// The lobby's crew pads and the heists they launch. Pure state changes on WorldState; WorldRoom
// sends the messages (heistStart, hostChanged, heistOver) and relays the heist traffic.

// The countdowns, adjustable by the tests.
export const padTiming = { countdownMs: PAD_COUNTDOWN_MS, fullCountdownMs: PAD_FULL_COUNTDOWN_MS };
export function __setPadTimingForTest(t: Partial<typeof padTiming> | null): void {
  Object.assign(padTiming, { countdownMs: PAD_COUNTDOWN_MS, fullCountdownMs: PAD_FULL_COUNTDOWN_MS }, t ?? {});
}

// The PAD_COUNT pads a new room starts with: three, all normal.
export function createPads(state: WorldState): void {
  for (let i = 0; i < PAD_COUNT; i++) {
    const pad = new PadState();
    pad.index = i;
    pad.difficulty = PAD_DIFFICULTIES[i];
    state.pads.push(pad);
  }
}

const padAt = (state: WorldState, index: unknown): PadState | undefined =>
  Number.isInteger(index) && (index as number) >= 0 && (index as number) < state.pads.length ? state.pads.at(index as number) : undefined;

const remove = (list: { indexOf(v: string): number; splice(i: number, n: number): unknown }, sid: string): boolean => {
  const i = list.indexOf(sid);
  if (i < 0) return false;
  list.splice(i, 1);
  return true;
};

// `leavePad`: takes the session off every pad it waits on. An emptied pad goes idle (startsAt 0).
export function leavePad(state: WorldState, sid: string): boolean {
  let left = false;
  for (const pad of state.pads) {
    if (!remove(pad.members, sid)) continue;
    left = true;
    if (pad.members.length === 0) pad.startsAt = 0;
  }
  return left;
}

// `joinPad` { pad }: only from the lobby (checked by the caller), onto a pad with room (a launched pad is
// empty again at once, so it never waits on a running heist). Moves the
// session off any other pad. The first member starts the countdown; a full pad shortens it.
export function joinPad(state: WorldState, sid: string, index: unknown, now: number): boolean {
  const pad = padAt(state, index);
  if (!pad) return false;
  if (pad.members.includes(sid)) return true;
  if (pad.members.length >= PAD_SIZE) return false;
  leavePad(state, sid);
  pad.members.push(sid);
  if (pad.members.length === 1 || pad.startsAt === 0) pad.startsAt = now + padTiming.countdownMs;
  if (pad.members.length >= PAD_SIZE) pad.startsAt = Math.min(pad.startsAt, now + padTiming.fullCountdownMs);
  return true;
}

// Pads whose countdown has run out (with someone on them).
export function duePads(state: WorldState, now: number): PadState[] {
  const due: PadState[] = [];
  for (const pad of state.pads) if (pad.members.length > 0 && pad.startsAt > 0 && pad.startsAt <= now) due.push(pad);
  return due;
}

// Launches a pad's heist: its members become the crew of a new HeistState (the first one hosts, fresh seed
// and heist id) and every crew player moves to the heist's zone. The pad itself is idle again at once.
// Returns the new heist (null = nothing launched).
export function launchPad(state: WorldState, pad: PadState): HeistState | null {
  const crew = [...pad.members].filter((sid) => state.players.has(sid));
  pad.members.clear();
  pad.startsAt = 0;
  if (!crew.length) return null;
  const heist = new HeistState();
  heist.id = randomBytes(6).toString("base64url");
  heist.pad = pad.index;
  heist.difficulty = pad.difficulty;
  for (const sid of crew) heist.crew.push(sid);
  heist.host = crew[0];
  heist.seed = randomBytes(4).readUInt32LE(0);
  heist.money = 0;
  heist.target = HEIST_TARGETS[pad.difficulty as keyof typeof HEIST_TARGETS] ?? HEIST_TARGETS.normal;
  state.heists.push(heist);
  for (const sid of crew) {
    const p = state.players.get(sid)!;
    p.zone = `h${heist.id}`;
    p.held = false;
    p.out = false;
  }
  return heist;
}

// What each crew client gets when its heist launches (`heistStart`).
export function heistStartOf(heist: HeistState) {
  return { pad: heist.pad, heistId: heist.id, seed: heist.seed, difficulty: heist.difficulty, target: heist.target, host: heist.host, crew: [...heist.crew] };
}

// The running heist whose crew holds this session.
export function crewHeistOf(state: WorldState, sid: string): HeistState | undefined {
  for (const heist of state.heists) if (heist.crew.includes(sid)) return heist;
  return undefined;
}

// `steal` { value } from the host: the crew bank grows by the value, rounded and clamped 0..STEAL_MAX.
export function steal(heist: HeistState, value: unknown): void {
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  heist.money += Math.min(STEAL_MAX, Math.max(0, Math.round(value)));
}

export interface CrewLeft {
  heist: HeistState;
  hostChanged: boolean; // the host left and the next crew member took over (heist.host)
  ended: boolean; // the crew is empty: the heist was removed
}

// Takes a session out of its heist (escaped, leaveHeist, gone from the room): back to the lobby zone.
// A leaving host hands over to the next crew member; the last one out ends the heist.
export function leaveCrew(state: WorldState, sid: string): CrewLeft | null {
  const heist = crewHeistOf(state, sid);
  if (!heist) return null;
  remove(heist.crew, sid);
  const p = state.players.get(sid);
  if (p) {
    p.zone = ZONE_LOBBY;
    p.held = false;
    p.out = false;
  }
  if (heist.crew.length === 0) {
    const i = state.heists.indexOf(heist);
    if (i >= 0) state.heists.splice(i, 1);
    return { heist, hostChanged: false, ended: true };
  }
  if (heist.host !== sid) return { heist, hostChanged: false, ended: false };
  heist.host = heist.crew.at(0)!;
  return { heist, hostChanged: true, ended: false };
}

// The heist relay's payloads are opaque objects; anything else, or one whose JSON is over `maxBytes`,
// is dropped.
export function fitsPayload(msg: unknown, maxBytes: number): msg is Record<string, unknown> {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return false;
  try {
    return Buffer.byteLength(JSON.stringify(msg)) <= maxBytes;
  } catch {
    return false; // not serialisable (e.g. a BigInt)
  }
}
