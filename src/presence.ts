import { AVATAR_MAX_LEN, ID_PATTERN, POSE_BOUNDS } from "./constants.js";
import type { PlayerState } from "./rooms/schema/WorldState.js";

// Presence: what the other clients need to draw a player in the world. Relayed through the
// roster as sent, only bounded here -- like the rest of the game it is client-authoritative and
// purely cosmetic. The server-set fields (`zone`, `escapes`) are never touched here.

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const b = POSE_BOUNDS;
const clampXZ = (v: number) => clamp(v, -b.xz, b.xz);
const clampY = (v: number) => clamp(v, b.yMin, b.yMax);

// `pose` { x, y, z, yaw, speed, grounded, crouch, grab, gx, gy, gz, held, out }: the player's feet
// position (m), heading (rad), speed (m/s), whether they stand on the floor, crouch, stretch their
// grabber arms (towards the grab point gx/gy/gz), are held in Grandpa's hand or are out of the heist.
// Every field is optional; a missing or malformed one keeps its last value.
export function applyPose(p: PlayerState, msg: unknown): void {
  if (!msg || typeof msg !== "object") return;
  const m = msg as Record<string, unknown>;
  if (finite(m.x)) p.x = clampXZ(m.x);
  if (finite(m.y)) p.y = clampY(m.y);
  if (finite(m.z)) p.z = clampXZ(m.z);
  if (finite(m.yaw)) p.yaw = Math.atan2(Math.sin(m.yaw), Math.cos(m.yaw));
  if (finite(m.speed)) p.speed = clamp(m.speed, 0, b.speed);
  if (typeof m.grounded === "boolean") p.grounded = m.grounded;
  if (typeof m.crouch === "boolean") p.crouch = m.crouch;
  if (typeof m.grab === "boolean") p.grab = m.grab;
  if (finite(m.gx)) p.gx = clampXZ(m.gx);
  if (finite(m.gy)) p.gy = clampY(m.gy);
  if (finite(m.gz)) p.gz = clampXZ(m.gz);
  if (typeof m.held === "boolean") p.held = m.held;
  if (typeof m.out === "boolean") p.out = m.out;
}

// `emote` { id }: the portal emote the sender is playing ("" = stopped). Catalogue ids are opaque
// slugs; anything else is ignored. Ownership is Boxity's business, not ours.
export function applyEmote(p: PlayerState, msg: unknown): void {
  const id = (msg as { id?: unknown })?.id;
  if (id === "" || (typeof id === "string" && ID_PATTERN.test(id))) p.emote = id;
}

// `setAvatar` { avatar }: the Bloxity look as an opaque JSON string ("" = default), length-capped.
export function applyAvatar(p: PlayerState, msg: unknown): void {
  const a = (msg as { avatar?: unknown })?.avatar;
  if (typeof a === "string" && a.length <= AVATAR_MAX_LEN) p.avatar = a;
}
