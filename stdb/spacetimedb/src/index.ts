import { schema, table, t } from "spacetimedb/server";

const spacetime = schema({
  pilot: table(
    { public: true },
    {
      id: t.identity().primaryKey(),
      name: t.string(),
      x: t.f32(),
      y: t.f32(),
      z: t.f32(),
      yaw: t.f32(),
      hp: t.u8(),
      thrusting: t.bool(),
      alive: t.bool(),
    }
  ),
  boss: table(
    { public: true },
    {
      id: t.u8().primaryKey(),
      x: t.f32(),
      y: t.f32(),
      z: t.f32(),
      hp: t.u8(),
    }
  ),
});

export default spacetime;

export const join = spacetime.reducer(
  { name: t.string() },
  (ctx, { name }) => {
    const existing = ctx.db.pilot.id.find(ctx.sender);
    if (existing) {
      ctx.db.pilot.id.update({
        ...existing,
        name,
        x: 0,
        y: 12,
        z: 30,
        yaw: 0,
        hp: 100,
        thrusting: false,
        alive: true,
      });
    } else {
      ctx.db.pilot.insert({
        id: ctx.sender,
        name,
        x: 0,
        y: 12,
        z: 30,
        yaw: 0,
        hp: 100,
        thrusting: false,
        alive: true,
      });
    }
    if (ctx.db.boss.id.find(1) === undefined) {
      ctx.db.boss.insert({ id: 1, x: 40, y: 28, z: -60, hp: 100 });
    }
  }
);

export const update_pose = spacetime.reducer(
  {
    x: t.f32(),
    y: t.f32(),
    z: t.f32(),
    yaw: t.f32(),
    thrusting: t.bool(),
  },
  (ctx, p) => {
    const me = ctx.db.pilot.id.find(ctx.sender);
    if (!me) return;
    ctx.db.pilot.id.update({
      ...me,
      x: p.x,
      y: p.y,
      z: p.z,
      yaw: p.yaw,
      thrusting: p.thrusting,
    });
  }
);

export const hit_boss = spacetime.reducer({ amount: t.u8() }, (ctx, { amount }) => {
  const b = ctx.db.boss.id.find(1);
  if (!b) return;
  ctx.db.boss.id.update({
    ...b,
    hp: b.hp > amount ? b.hp - amount : 0,
  });
});
