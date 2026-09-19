import * as THREE from 'three';
import * as Cesium from 'cesium';
import { site } from '../sites.js';

// ---------------------------------------------------------------------------
// Combat space — drones, missiles and explosions live in one flat local frame
// in metres around the centre of the site being flown (sites.js): x = east,
// y = north, z = up (altitude). It is the same 111 320 m/deg approximation the
// flight model and the server's drone tick use, around the same point, so a
// point here lands exactly where a suit at the same lon/lat/alt is drawn.
// ---------------------------------------------------------------------------

/** Geodetic position ({longitude, latitude, altitude}) -> local metres. */
export function toLocal(geo, out = new THREE.Vector3(), lift = 0) {
  return out.set(
    (geo.longitude - site.longitude) * site.mPerLon,
    (geo.latitude - site.latitude) * site.mPerLat,
    geo.altitude + lift,
  );
}

/** Local metres -> ECEF. */
export function localToEcef(v, result = new Cesium.Cartesian3()) {
  return Cesium.Cartesian3.fromDegrees(
    site.longitude + v.x / site.mPerLon,
    site.latitude + v.y / site.mPerLat,
    v.z,
    Cesium.Ellipsoid.WGS84,
    result,
  );
}

/** Move a flight state (longitude/latitude/altitude) by a local offset in metres. */
export function nudgeGeo(state, offset) {
  state.longitude += offset.x / site.mPerLon;
  state.latitude += offset.y / site.mPerLat;
  state.altitude += offset.z;
}

/** Closest distance from point `p` to the segment a-b. */
const segAB = new THREE.Vector3();
const segAP = new THREE.Vector3();
export function distanceToSegment(p, a, b) {
  segAB.subVectors(b, a);
  segAP.subVectors(p, a);
  const len2 = segAB.lengthSq();
  const t = len2 > 0 ? Math.max(0, Math.min(1, segAP.dot(segAB) / len2)) : 0;
  return segAP.addScaledVector(segAB, -t).length();
}

/**
 * World layer in the suit overlay. Objects added here are posed in local
 * metres with ordinary Three transforms (their axes are east/north/up); each
 * frame the layer places them camera-relative exactly like the suits, which
 * keeps globe-scale coordinates out of the float pipeline.
 *
 * @param overlay the suit overlay from initSuitOverlay
 * @param viewer  the Cesium viewer whose camera the overlay mirrors
 * @returns {{
 *   add(object, local:THREE.Vector3): {object, local, remove()},
 *   warm(object): void,
 *   toCamera(local, out): THREE.Vector3  // camera space: -Z ahead, +X right, +Y up
 *   project(local, out): boolean         // -> out.x/out.y in CSS px, out.z = metres ahead
 *   pxPerMetre(depth): number,
 * }}
 */
export function createWorldLayer(overlay, viewer) {
  const layer = new THREE.Group();
  const items = new Set();

  // Rotation from local axes to ECEF. A site is small enough that one frame
  // at its centre serves every object.
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(
    Cesium.Cartesian3.fromDegrees(site.longitude, site.latitude, 0),
  );
  const enuRotation = Cesium.Matrix4.getMatrix3(enu, new Cesium.Matrix3());
  const viewRotation = new Cesium.Matrix3();
  const camRotation = new Cesium.Matrix3();
  const ecef = new Cesium.Cartesian3();
  const camPos = new Cesium.Cartesian3();
  const rotation = new THREE.Matrix4();

  let projection = null;
  let size = { w: 1, h: 1, fovScale: 1 };

  function prepare(view, camera, w, h) {
    projection = camera.projectionMatrix;
    size = { w, h, fovScale: h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) };

    Cesium.Matrix4.getMatrix3(view, viewRotation);
    Cesium.Matrix3.multiply(viewRotation, enuRotation, camRotation);
    // Cesium matrices are column-major, like Three's element array.
    const r = camRotation;
    rotation.set(r[0], r[3], r[6], 0, r[1], r[4], r[7], 0, r[2], r[5], r[8], 0, 0, 0, 0, 1);

    for (const item of items) {
      if (!item.root.visible) continue;
      Cesium.Matrix4.multiplyByPoint(view, localToEcef(item.local, ecef), camPos);
      item.root.matrix.copy(rotation).setPosition(camPos.x, camPos.y, camPos.z);
      item.root.matrixWorldNeedsUpdate = true;
    }
  }

  function add(object, local = new THREE.Vector3()) {
    const root = new THREE.Group();
    root.matrixAutoUpdate = false;
    root.add(object);
    layer.add(root);
    const item = {
      object,
      root,
      local,
      remove() {
        layer.remove(root);
        items.delete(item);
        // Free what this object owns. Assets marked `userData.shared` (a GLB
        // template's meshes, the missile hulls) and Three's one sprite quad
        // belong to everything still flying: disposing them would make the
        // survivors re-upload their buffers and recompile their shaders on
        // the next frame — a visible hitch on every kill.
        root.traverse((o) => {
          if (o.geometry && !o.isSprite && !o.geometry.userData.shared) o.geometry.dispose();
          const materials = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of materials) {
            if (m && !m.userData.shared) m.dispose(); // textures stay alive
          }
        });
      },
    };
    items.add(item);
    return item;
  }

  // A local point in the live Cesium camera's space (the chase camera has
  // already been placed for this frame by the time combat runs).
  function toCamera(local, out) {
    Cesium.Matrix4.multiplyByPoint(viewer.camera.viewMatrix, localToEcef(local, ecef), camPos);
    return out.set(camPos.x, camPos.y, camPos.z);
  }

  // Screen position of a local point. Returns false when it is behind the
  // lens (or before the first frame has been drawn).
  const ndc = new THREE.Vector3();
  function project(local, out) {
    if (!projection) return false;
    toCamera(local, ndc);
    if (ndc.z > -1) return false;
    const depth = -ndc.z;
    ndc.applyMatrix4(projection);
    out.x = (ndc.x + 1) * 0.5 * size.w;
    out.y = (1 - ndc.y) * 0.5 * size.h;
    out.z = depth;
    return true;
  }

  overlay.addObject(layer, prepare);
  return {
    add,
    /** Compile an object's shaders now (see overlay.warm). */
    warm: (object) => overlay.warm(object),
    toCamera,
    project,
    pxPerMetre: (depth) => size.fovScale / Math.max(1, depth),
    get width() {
      return size.w;
    },
    get height() {
      return size.h;
    },
  };
}
