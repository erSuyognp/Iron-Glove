import { Identity } from "spacetimedb";
import { DbConnection, type EventContext } from "./module_bindings";

export type PilotSnap = {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  thrusting: boolean;
  alive: boolean;
};

export type StdbHandle = {
  connected: boolean;
  identityHex: string | null;
  bossHp: number;
  pilots: Map<string, PilotSnap>;
  connect: (name?: string) => void;
  updatePose: (x: number, y: number, z: number, yaw: number, thrusting: boolean) => void;
  hitBoss: (amount?: number) => void;
  onBossHp: (cb: (hp: number) => void) => void;
  onPilots: (cb: (pilots: PilotSnap[]) => void) => void;
  onStatus: (cb: (msg: string) => void) => void;
};

function toWs(host: string): string {
  if (host.startsWith("ws")) return host;
  if (host.startsWith("https://")) return "wss://" + host.slice("https://".length);
  if (host.startsWith("http://")) return "ws://" + host.slice("http://".length);
  return host;
}

export function createIronGloveStdb(opts?: {
  host?: string;
  dbName?: string;
}): StdbHandle {
  const host = toWs(opts?.host ?? "wss://maincloud.spacetimedb.com");
  const dbName = opts?.dbName ?? "iron-glove-suyog";

  let conn: DbConnection | null = null;
  let myId: string | null = null;
  const pilots = new Map<string, PilotSnap>();
  let bossHp = 100;
  const bossListeners = new Set<(hp: number) => void>();
  const pilotListeners = new Set<(pilots: PilotSnap[]) => void>();
  const statusListeners = new Set<(msg: string) => void>();

  const emitStatus = (msg: string) => statusListeners.forEach((cb) => cb(msg));
  const emitBoss = () => bossListeners.forEach((cb) => cb(bossHp));
  const emitPilots = () => pilotListeners.forEach((cb) => cb([...pilots.values()]));

  const snapPilot = (row: {
    id: { toHexString(): string };
    name: string;
    x: number;
    y: number;
    z: number;
    yaw: number;
    thrusting: boolean;
    alive: boolean;
  }): PilotSnap => ({
    id: row.id.toHexString(),
    name: row.name,
    x: row.x,
    y: row.y,
    z: row.z,
    yaw: row.yaw,
    thrusting: row.thrusting,
    alive: row.alive,
  });

  const handle: StdbHandle = {
    get connected() {
      return conn !== null;
    },
    get identityHex() {
      return myId;
    },
    get bossHp() {
      return bossHp;
    },
    get pilots() {
      return pilots;
    },
    connect(name = "Pilot") {
      if (conn) return;
      emitStatus("connecting…");
      DbConnection.builder()
        .withUri(host)
        .withDatabaseName(dbName)
        .onConnect((c, identity: Identity) => {
          conn = c;
          myId = identity.toHexString();
          emitStatus("online");

          c.db.boss.onInsert((_ctx: EventContext, row) => {
            bossHp = row.hp;
            emitBoss();
          });
          c.db.boss.onUpdate((_ctx: EventContext, _o, row) => {
            bossHp = row.hp;
            emitBoss();
          });
          c.db.pilot.onInsert((_ctx: EventContext, row) => {
            const s = snapPilot(row);
            pilots.set(s.id, s);
            emitPilots();
          });
          c.db.pilot.onUpdate((_ctx: EventContext, _o, row) => {
            const s = snapPilot(row);
            pilots.set(s.id, s);
            emitPilots();
          });
          c.db.pilot.onDelete((_ctx: EventContext, row) => {
            pilots.delete(row.id.toHexString());
            emitPilots();
          });

          c.subscriptionBuilder()
            .onApplied(() => {
              void c.reducers.join({ name });
              emitStatus(`joined as ${name}`);
            })
            .subscribe(["SELECT * FROM pilot", "SELECT * FROM boss"]);
        })
        .onDisconnect(() => {
          conn = null;
          emitStatus("offline");
        })
        .onConnectError((_ctx, err) => {
          conn = null;
          emitStatus("error: " + (err?.message ?? String(err)));
        })
        .build();
    },
    updatePose(x, y, z, yaw, thrusting) {
      if (!conn) return;
      void conn.reducers.updatePose({ x, y, z, yaw, thrusting });
    },
    hitBoss(amount = 12) {
      if (!conn) return;
      void conn.reducers.hitBoss({ amount });
    },
    onBossHp(cb) {
      bossListeners.add(cb);
    },
    onPilots(cb) {
      pilotListeners.add(cb);
    },
    onStatus(cb) {
      statusListeners.add(cb);
    },
  };

  return handle;
}

declare global {
  interface Window {
    IronGloveStdb: { create: typeof createIronGloveStdb };
  }
}

if (typeof window !== "undefined") {
  window.IronGloveStdb = { create: createIronGloveStdb };
}
