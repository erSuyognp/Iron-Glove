import { Identity } from "spacetimedb";
import { DbConnection, type ErrorContext, type EventContext } from "./module_bindings";

const HOST = (process.env.SPACETIMEDB_HOST ?? "https://maincloud.spacetimedb.com").replace(/^http/, "ws");
const DB_NAME = process.env.SPACETIMEDB_DB_NAME ?? "iron-glove-suyog";

console.log(`Connecting to ${HOST} / ${DB_NAME} ...`);

DbConnection.builder()
  .withUri(HOST)
  .withDatabaseName(DB_NAME)
  .onConnect((conn, identity: Identity, _token: string) => {
    console.log("Connected. identity=", identity.toHexString().slice(0, 16) + "...");

    conn.db.boss.onInsert((_ctx: EventContext, row) => {
      console.log(`Boss spawned id=${row.id} hp=${row.hp}`);
    });
    conn.db.boss.onUpdate((_ctx: EventContext, _old, row) => {
      console.log(`Boss hp=${row.hp}`);
    });
    conn.db.pilot.onInsert((_ctx: EventContext, row) => {
      console.log(`Pilot joined: ${row.name}`);
    });

    conn
      .subscriptionBuilder()
      .onApplied(() => {
        console.log("Subscribed. Calling join...");
        void conn.reducers.join({ name: "cli-pilot" });
      })
      .subscribe(["SELECT * FROM pilot", "SELECT * FROM boss"]);
  })
  .onDisconnect(() => console.log("Disconnected"))
  .onConnectError((_ctx: ErrorContext, error: Error) => {
    console.error("Connection error:", error);
    process.exit(1);
  })
  .build();
