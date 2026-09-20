import * as Cesium from 'cesium';

// ---------------------------------------------------------------------------
// A small billboard particle pool for mission effects (flames, smoke, water).
//
// Cesium's own ParticleSystem runs off the viewer clock, which this game keeps
// frozen so the sun stays put (cesium/world.js). These are stepped from the
// game loop's dt instead. Particles live in a flat east/north/up frame in
// metres around a fixed origin, which is exact enough across one site.
// ---------------------------------------------------------------------------

// A soft round sprite; the billboard colour tints it.
function softDot() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  const fade = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  fade.addColorStop(0, 'rgba(255,255,255,1)');
  fade.addColorStop(0.35, 'rgba(255,255,255,0.7)');
  fade.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = fade;
  g.fillRect(0, 0, size, size);
  return canvas;
}

/**
 * @param {Cesium.Viewer} viewer
 * @param {{longitude:number, latitude:number}} origin  centre of the local frame
 * @param {number} capacity  most particles alive at once (the oldest is reused)
 */
export function createParticles(viewer, origin, capacity = 400) {
  const collection = viewer.scene.primitives.add(
    new Cesium.BillboardCollection({ blendOption: Cesium.BlendOption.TRANSLUCENT }),
  );
  const frame = Cesium.Transforms.eastNorthUpToFixedFrame(
    Cesium.Cartesian3.fromDegrees(origin.longitude, origin.latitude, 0),
  );
  const image = softDot();
  const scratch = new Cesium.Cartesian3();
  const pool = [];
  let next = 0;

  for (let i = 0; i < capacity; i++) {
    const billboard = collection.add({ image, show: false, sizeInMeters: true, width: 1, height: 1 });
    pool.push({ billboard, life: 0, age: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, gravity: 0, drag: 0, size0: 1, size1: 1, c0: null, c1: null, alpha: 1 });
  }

  /**
   * Launch one particle. Positions and velocities are local metres (east,
   * north, altitude). It grows from size0 to size1 and fades from colour c0 to
   * c1 (Cesium.Color) over its life.
   */
  function emit(p) {
    const particle = pool[next];
    next = (next + 1) % capacity;
    Object.assign(particle, { age: 0, gravity: 0, drag: 0, alpha: 1 }, p);
    particle.billboard.show = true;
  }

  const color = new Cesium.Color();
  function update(dt) {
    for (const p of pool) {
      if (p.age >= p.life) continue;
      p.age += dt;
      if (p.age >= p.life) {
        p.billboard.show = false;
        continue;
      }
      const damp = Math.max(0, 1 - p.drag * dt);
      p.vx *= damp;
      p.vy *= damp;
      p.vz = p.vz * damp - p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;

      const t = p.age / p.life;
      const size = p.size0 + (p.size1 - p.size0) * t;
      Cesium.Cartesian3.fromElements(p.x, p.y, p.z, scratch);
      p.billboard.position = Cesium.Matrix4.multiplyByPoint(frame, scratch, scratch);
      p.billboard.width = size;
      p.billboard.height = size;
      Cesium.Color.lerp(p.c0, p.c1, t, color);
      // Ease in over the first tenth of the life so nothing pops into view.
      color.alpha *= p.alpha * Math.min(1, t * 10);
      p.billboard.color = color;
    }
  }

  // The local frame's altitude axis starts at the ellipsoid, like a suit's.
  function toLocal(geo, mPerLon, mPerLat) {
    return {
      x: (geo.longitude - origin.longitude) * mPerLon,
      y: (geo.latitude - origin.latitude) * mPerLat,
      z: geo.altitude,
    };
  }

  function clear() {
    for (const p of pool) {
      p.life = 0;
      p.age = 0;
      p.billboard.show = false;
    }
  }

  function destroy() {
    viewer.scene.primitives.remove(collection);
  }

  return { emit, update, toLocal, clear, destroy, primitive: collection };
}
