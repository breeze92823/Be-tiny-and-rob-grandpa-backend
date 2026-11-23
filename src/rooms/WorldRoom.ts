import { Room, Client, CloseCode } from "colyseus";
import { WorldState, PlayerState, type PadState } from "./schema/WorldState.js";
import {
  HA_MAX_BYTES, HB_MAX_BYTES, HS_MAX_BYTES, LEADERBOARD_EVERY_MS, NAME_MAX, PAD_TICK_MS, PFP_MAX_LEN, RECONNECT_SECONDS,
  PRIVATE_KEEPALIVE_MS, ROOM_MAX_CLIENTS, ZONE_LOBBY,
} from "../constants.js";
import { getPlayers, type PlayerDoc } from "../db.js";
import { maxStats, sanitizeProgress } from "../sanitize.js";
import { addPlayerSource, verifyAdReward, verifyPlayer, type ReportedPlayer, type VerifiedUser } from "../bloxity.js";
import { applyAvatar, applyEmote, applyPose } from "../presence.js";
import { ranksOf, topBoards } from "../leaderboard.js";
import { createPads, crewPadOf, duePads, fitsPayload, heistStartOf, joinPad, launchPad, leaveCrew, leavePad, steal } from "../pads.js";

function sanitizeName(raw: unknown): string {
  return typeof raw === "string" ? raw.slice(0, NAME_MAX) : "";
}

function sanitizePfp(raw: unknown): string {
  return typeof raw === "string" && raw.length <= PFP_MAX_LEN && /^https?:\/\//i.test(raw) ? raw : "";
}

/**
 * Room every client joins via `client.joinOrCreate("world", { token, username, pfp })`. `token` is
 * the player's Bloxity token (`Legion.SDK.auth.getToken()`): the server verifies it with Bloxity
 * (onAuth, bloxity.ts) and uses only the account id Bloxity returns -- an id sent by the client is
 * never trusted, and a player without a valid token is a guest. Loads and saves each signed-in
 * player's progress (MongoDB, see db.ts). The game is client-authoritative: no gameplay rules live
 * here, saves are only bounded (sanitize.ts). One room = one lobby with 4 crew pads (pads.ts): a pad
 * launches a heist for its crew, whose host runs Grandpa + the physics and streams them to the others
 * through this room (`hs` / `ha` / `hb`). A full room spills into a fresh one automatically.
 */
// Test seam: how long an empty private room lives.
let privateKeepAliveMs = PRIVATE_KEEPALIVE_MS;
export function __setPrivateKeepAliveForTest(ms: number | null): void {
  privateKeepAliveMs = ms ?? PRIVATE_KEEPALIVE_MS;
}

export class WorldRoom extends Room<{ state: WorldState }> {
  state = new WorldState();
  maxClients = ROOM_MAX_CLIENTS;

  // sessionId -> user id (Bloxity id). Deliberately NOT part of WorldState: it only gates this
  // room's own Mongo reads/writes. Guests have no entry.
  userIds = new Map<string, string>();

  // sessionIds that already got a progress/noProgress answer for their current identity.
  private identified = new Set<string>();
  // sessionIds whose current identity's save has been read: only these may write. A save sent
  // before the load answered would overwrite the stored progress with a fresh player's defaults.
  private loaded = new Set<string>();
  // sessionId -> the server's copy of the signed-in player's progress (what the Boxity stats and
  // leaderboard reporters read, bloxity.ts); set by the load, kept current by each save.
  private progress = new Map<string, Partial<PlayerDoc>>();
  // sessionId -> counter of the newest `identify` token check, so an older answer can't win.
  private identifying = new Map<string, number>();
  private removeSource: (() => void) | null = null;

  messages = {
    // Debounced push of the client's whole progress. Upserts, so a first save creates the document.
    // The lifetime stats go through $max, so a save can never lower one.
    saveProgress: async (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      const patch = sanitizeProgress(msg);
      if (!p || !patch || !this.loaded.has(client.sessionId)) return;

      const userId = this.userIds.get(client.sessionId);
      if (!userId) return;
      const prev = this.progress.get(client.sessionId);
      this.progress.set(client.sessionId, { ...prev, ...patch, stats: maxStats(prev?.stats, patch.stats) });
      const players = getPlayers();
      if (!players) return; // Mongo unset/unreachable -- degrade silently
      const { stats, ...rest } = patch;
      try {
        await players.updateOne(
          { _id: userId },
          {
            // Display name comes from this connection's own PlayerState, not `msg`.
            $set: { ...rest, username: p.username || "Player", updatedAt: new Date() },
            ...(stats ? { $max: Object.fromEntries(Object.entries(stats).map(([k, v]) => [`stats.${k}`, v])) } : {}),
            $setOnInsert: { version: 1 },
          },
          { upsert: true },
        );
      } catch (err) {
        console.warn("[WorldRoom] saveProgress failed", err);
      }
    },
    // Presence (presence.ts): the sender's pose ~10x/s and its Bloxity look, relayed through the
    // roster so everyone can draw them in the world.
    pose: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyPose(p, msg);
    },
    // The portal emote the sender plays (or "" when it stops), shown on their character for the others.
    emote: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyEmote(p, msg);
    },
    setAvatar: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyAvatar(p, msg);
    },
    // Crew pads (pads.ts). Stepping on a pad from the lobby; moves the player off any other pad.
    joinPad: (client: Client, msg: { pad?: unknown }) => {
      const p = this.state.players.get(client.sessionId);
      if (p && p.zone === ZONE_LOBBY) joinPad(this.state, client.sessionId, msg?.pad, Date.now());
    },
    leavePad: (client: Client) => {
      leavePad(this.state, client.sessionId);
    },
    // The heist relay. `hs` (host snapshot) and `hb` (host event) come only from the host of a running
    // pad and go to every other crew member; `ha` (crew action) goes from a crew member to the host,
    // tagged with the sender. Payloads are opaque objects, size-capped.
    hs: (client: Client, msg: unknown) => this.relayFromHost(client, "hs", msg, HS_MAX_BYTES),
    hb: (client: Client, msg: unknown) => this.relayFromHost(client, "hb", msg, HB_MAX_BYTES),
    ha: (client: Client, msg: unknown) => {
      const pad = crewPadOf(this.state, client.sessionId);
      if (!pad || pad.host === client.sessionId || !fitsPayload(msg, HA_MAX_BYTES)) return;
      this.sendTo(pad.host, "ha", { ...msg, from: client.sessionId });
    },
    // Loot out of the house: the host banks its value for the crew.
    steal: (client: Client, msg: { value?: unknown }) => {
      const pad = crewPadOf(this.state, client.sessionId);
      if (pad && pad.host === client.sessionId) steal(pad, msg?.value);
    },
    // The sender got away through the van (counted in `escapes`), or quit the heist for the lobby.
    escaped: (client: Client) => this.exitHeist(client.sessionId, true),
    leaveHeist: (client: Client) => this.exitHeist(client.sessionId, false),
    // Re-states identity after a login/logout that happens AFTER join (a guest who signs in
    // mid-session): `token` is the player's current Bloxity token ("" after signing out). The server
    // verifies it with Bloxity and answers with progress/noProgress for the verified account.
    // A message without `token` only refreshes the display name / picture.
    identify: async (client: Client, msg: { username?: string; token?: unknown; pfp?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      if (typeof msg?.username === "string") p.username = sanitizeName(msg.username);
      if (typeof msg?.pfp === "string") p.pfp = sanitizePfp(msg.pfp);
      if (typeof msg?.token !== "string") return;
      const turn = (this.identifying.get(client.sessionId) ?? 0) + 1;
      this.identifying.set(client.sessionId, turn);
      const user = await verifyPlayer(msg.token);
      // Gone, or a newer identify superseded this one while Bloxity answered.
      if (this.state.players.get(client.sessionId) !== p || this.identifying.get(client.sessionId) !== turn) return;
      if (user) p.username = sanitizeName(user.displayName || user.username) || p.username;
      this.setUserId(client, p, user?._id ?? "");
    },
    // A rewarded ad finished (`Legion.SDK.ads.showRewarded`): the client sends its reward token and
    // only grants the reward when Bloxity confirms it here (single use, this game, 5 minutes).
    adReward: async (client: Client, msg: { token?: unknown; placement?: unknown }) => {
      const ok = await verifyAdReward(msg?.token);
      const placement = typeof msg?.placement === "string" ? msg.placement.slice(0, 32) : "";
      try {
        client.send("adRewardResult", { ok, placement });
      } catch {
        // Gone meanwhile.
      }
    },
  };

  // Verifies the Bloxity token sent in the join options (bloxity.ts): `client.auth.user` is the
  // verified account, or null for a guest. Never rejects -- a guest may play, just never saved.
  async onAuth(_client: Client, options?: { token?: unknown }) {
    return { user: await verifyPlayer(options?.token) };
  }

  // `private: true` in the creator's options = a Play-with-friends room (`?instantMultiplayer=true`):
  // never listed for strangers' joinOrCreate, only reachable by room id (the invite link), and kept
  // alive PRIVATE_KEEPALIVE_MS while empty so a reconnect can come back to it.
  private privateRoom = false;
  private emptyTimer?: { clear(): void };

  private checkEmptyPrivate() {
    if (!this.privateRoom || this.clients.length > 0) return;
    this.emptyTimer?.clear();
    this.emptyTimer = this.clock.setTimeout(() => {
      if (this.clients.length === 0) void this.disconnect();
    }, privateKeepAliveMs);
  }

  onCreate(options?: { private?: unknown }) {
    if (options?.private === true) {
      this.privateRoom = true;
      void this.setPrivate(true);
      this.autoDispose = false;
      this.checkEmptyPrivate();
    }
    createPads(this.state);
    // Crew pads: launch every pad whose countdown ran out.
    this.clock.setInterval(() => this.tickPads(Date.now()), PAD_TICK_MS);
    // Leaderboards (leaderboard.ts): everyone gets the top lists + their own ranks every
    // LEADERBOARD_EVERY_MS, and once right after their save loads.
    this.clock.setInterval(() => {
      for (const c of this.clients) void this.sendLeaderboard(c);
    }, LEADERBOARD_EVERY_MS);
    // The Boxity stats / leaderboard reporters read this room's signed-in players (bloxity.ts).
    this.removeSource = addPlayerSource(() => this.reportedPlayers());
  }

  onDispose() {
    this.removeSource?.();
  }

  // Launches every pad whose countdown has run out at `now` (server epoch ms): its members become the
  // crew and each of them gets `heistStart`. Public so the tests can drive the pad clock.
  tickPads(now: number) {
    for (const pad of duePads(this.state, now)) {
      const crew = launchPad(this.state, pad);
      if (!crew.length) continue;
      const start = heistStartOf(pad);
      for (const sid of crew) this.sendTo(sid, "heistStart", start);
    }
  }

  // `hs` / `hb`: from the host of a running pad only, to every other crew member (never echoed back).
  private relayFromHost(client: Client, type: string, msg: unknown, maxBytes: number) {
    const pad = crewPadOf(this.state, client.sessionId);
    if (!pad || pad.host !== client.sessionId || !fitsPayload(msg, maxBytes)) return;
    for (const sid of pad.crew) if (sid !== client.sessionId) this.sendTo(sid, type, msg);
  }

  // Takes a session out of its heist (pads.ts leaveCrew) and tells the rest of the crew about a new host;
  // when the last one is out the pad resets and the room hears `heistOver`.
  private exitHeist(sessionId: string, escaped: boolean) {
    const left = leaveCrew(this.state, sessionId);
    if (!left) return;
    const p = this.state.players.get(sessionId);
    if (escaped && p) p.escapes += 1;
    if (left.hostChanged) this.sendToCrew(left.pad, "hostChanged", { pad: left.pad.index, host: left.pad.host });
    if (left.ended) this.broadcast("heistOver", { pad: left.pad.index });
  }

  private sendTo(sessionId: string, type: string, msg: unknown) {
    const c = this.clients.get(sessionId);
    if (!c) return; // dropped (waiting to reconnect) or gone
    try {
      c.send(type, msg);
    } catch {
      // Gone meanwhile.
    }
  }

  private sendToCrew(pad: PadState, type: string, msg: unknown) {
    for (const sid of pad.crew) this.sendTo(sid, type, msg);
  }

  private reportedPlayers(): ReportedPlayer[] {
    const out: ReportedPlayer[] = [];
    for (const [sid, userId] of this.userIds) {
      const doc = this.progress.get(sid);
      if (!doc || !this.state.players.has(sid)) continue;
      const s = doc.stats;
      out.push({
        userId, escapes: s?.escapes ?? 0, earned: s?.earned ?? 0, bestHaul: s?.bestHaul ?? 0, stolen: s?.stolen ?? 0,
        heists: s?.heists ?? 0, caught: s?.caught ?? 0, jobs: s?.jobs ?? 0,
      });
    }
    return out;
  }

  // `leaderboard` { boards: { escapes|earned|bestHaul|stolen: [{ name, value }] }, ranks: { stat: n | null } }.
  private async sendLeaderboard(client: Client) {
    const userId = this.userIds.get(client.sessionId) ?? "";
    const [boards, ranks] = await Promise.all([topBoards(), ranksOf(userId)]);
    if (!this.state.players.has(client.sessionId)) return;
    try {
      client.send("leaderboard", { boards, ranks });
    } catch {
      // Gone meanwhile.
    }
  }

  onJoin(client: Client, options?: { username?: string; pfp?: string; pose?: unknown; avatar?: string }) {
    this.emptyTimer?.clear();
    const user: VerifiedUser | null = client.auth?.user ?? null;
    const p = new PlayerState();
    // A verified player's name is Bloxity's own; a guest's is whatever it calls itself (display only).
    p.username = sanitizeName(user ? user.displayName || user.username : options?.username) || sanitizeName(options?.username);
    p.pfp = sanitizePfp(options?.pfp);
    // Presence from the join options, so the others draw the newcomer right away.
    applyPose(p, options?.pose);
    applyAvatar(p, options);
    p.zone = ZONE_LOBBY;
    this.state.players.set(client.sessionId, p);
    this.setUserId(client, p, user?._id ?? "");
  }

  // A deliberate `room.leave()` closes with CONSENTED -- drop the player at once. Anything
  // else (WiFi blip, backgrounded tab) gets RECONNECT_SECONDS to reconnect with the same session;
  // meanwhile they give up their pad seat (a dropped player is never launched into a heist) but stay
  // in their heist's crew until the window closes.
  async onLeave(client: Client, code?: number) {
    if (code === CloseCode.CONSENTED) {
      void this.stampLastSeen(client.sessionId);
      this.forgetSession(client.sessionId);
      this.checkEmptyPrivate();
      return;
    }
    leavePad(this.state, client.sessionId);
    try {
      await this.allowReconnection(client, RECONNECT_SECONDS);
    } catch {
      void this.stampLastSeen(client.sessionId);
      this.forgetSession(client.sessionId);
      this.checkEmptyPrivate();
    }
  }

  // Server-clock "last seen" for a player who has really gone. Call before forgetSession.
  private async stampLastSeen(sessionId: string) {
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (!userId || !players) return;
    try {
      await players.updateOne({ _id: userId }, { $set: { lastSeen: Date.now() } });
    } catch (err) {
      console.warn("[WorldRoom] stampLastSeen failed", err);
    }
  }

  // Drops a session's per-connection bookkeeping: off its pad, out of its heist, out of the roster.
  private forgetSession(sessionId: string) {
    leavePad(this.state, sessionId);
    this.exitHeist(sessionId, false);
    this.state.players.delete(sessionId);
    this.userIds.delete(sessionId);
    this.identified.delete(sessionId);
    this.loaded.delete(sessionId);
    this.progress.delete(sessionId);
    this.identifying.delete(sessionId);
  }

  // `userId` is the account id BLOXITY returned for a verified token ("" = a guest: nothing is loaded
  // or saved for them). Never pass an id the client sent. Called from both onJoin and `identify`;
  // answers with progress / noProgress / serverError.
  private setUserId(client: Client, p: PlayerState, userId: string) {
    userId = userId.slice(0, 128);
    const prev = this.userIds.get(client.sessionId) || "";
    // No change (e.g. a username-only identify) -- but the very first call must still answer.
    if (userId === prev && this.identified.has(client.sessionId)) return;
    this.identified.add(client.sessionId);
    this.loaded.delete(client.sessionId); // no writes until the new identity's save is read
    this.progress.delete(client.sessionId); // the old account's numbers are not this one's
    p.signedIn = !!userId;
    p.userId = userId; // the verified account id ("" for a guest), public so chat bubbles find their character

    if (userId) {
      // Evict any OTHER live session already claiming this account, so one account never has
      // two racing Mongo writers (a crashed tab lingers up to RECONNECT_SECONDS via
      // allowReconnection in onLeave). It closes with CONSENTED (4000).
      for (const [sid, uid] of this.userIds) {
        if (sid === client.sessionId || uid !== userId) continue;
        this.forgetSession(sid);
        const stale = this.clients.get(sid);
        if (stale) {
          try {
            stale.leave(CloseCode.CONSENTED);
          } catch {
            // Already gone -- nothing to clean up.
          }
        }
      }
      this.userIds.set(client.sessionId, userId);
    } else {
      // No identity: stop persisting for this connection. (The client flushes a final
      // saveProgress under the OLD id before sending `identify`.)
      this.userIds.delete(client.sessionId);
    }

    void this.loadProgress(client, userId, p);
  }

  // Sends the saved doc to just this client so it can hydrate its state ("progress"), or
  // "noProgress" when there is nothing to load (new account, guest, or Mongo unset). A failed read
  // sends "serverError" and keeps saving off, so a save that could not be read is never overwritten.
  private async loadProgress(client: Client, userId: string, p: PlayerState) {
    const players = getPlayers();
    let doc: PlayerDoc | null = null;
    if (userId && players) {
      try {
        doc = await players.findOne({ _id: userId });
      } catch (err) {
        console.warn("[WorldRoom] loadProgress failed", err);
        client.send("serverError", {});
        return;
      }
    }
    // The player may have left, or switched identity again, while the read was in flight.
    if (this.state.players.get(client.sessionId) !== p || (this.userIds.get(client.sessionId) ?? "") !== userId) return;

    this.loaded.add(client.sessionId);
    const saved = doc ? sanitizeProgress(doc) ?? {} : null;
    if (saved) this.progress.set(client.sessionId, saved);
    const now = Date.now();
    if (!saved) client.send("noProgress", { serverTime: now });
    else client.send("progress", { ...saved, serverTime: now });
    void this.sendLeaderboard(client);
  }
}
