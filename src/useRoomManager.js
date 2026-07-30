import { useCallback, useEffect, useRef, useState } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { LCCRender } from './vendor/sdk/lcc-web-sdk.js';
import { NEIGHBOURS, metaPath, arrival, ENTRY_ROOM, ROOMS, DEFAULT_SPAWN } from './doors.js';
import { buildLoadOptions, detectTier, RESIDENCY_BUDGET, tuneCameraForRoom } from './lccConfig.js';

/**
 * LCC is Z-up, Three is Y-up. Correcting on the model rather than the camera
 * keeps gravity at -Y, so the walker and every future physics assumption stay
 * simple. This exact matrix is from the SDK's own three.html example.
 */
export const LCC_MODEL_MATRIX = new THREE.Matrix4(
  -1, 0, 0, 0,
   0, 0, 1, 0,
   0, 1, 0, 0,
   0, 0, 0, 1
);

/**
 * Streams the 17 room scenes through one LCCRender manager.
 *
 * WHY THIS IS POSSIBLE: the manager is a singleton, but scenes are not.
 * load() calls createRenderer() and returns a fresh renderer each time,
 * getAllRenderers() returns an array, unload(obj) calls destroyRenderer(obj).
 *
 * RESIDENCY POLICY:
 *   active room      -> loaded, visible, collidable
 *   graph neighbours -> loaded, hidden (setVisible false), not collidable
 *   everything else  -> evicted, least-recently-used first
 *
 * WHY PREFETCH THE NEIGHBOURS: the door graph is a prediction. From Floor 2 the
 * visitor can reach exactly five rooms. Loading those five means walking through
 * any of those doors is instant. That is the whole trick behind "seamless".
 */
export function useRoomManager({ dev = false, appKey = null } = {}) {
  const { scene, camera, gl } = useThree();

  const tier = useRef(detectTier()).current;
  const budget = RESIDENCY_BUDGET[tier];

  /** roomId -> { renderer, mesh, state, lastUsed, visible } */
  const rooms = useRef(new Map()).current;
  const tick = useRef(0);
  const prefetchTimer = useRef(null);

  const [active, setActive] = useState(null);
  const [progress, setProgress] = useState(0);
  const [transitioning, setTransitioning] = useState(true);
  const [resident, setResident] = useState([]);

  const syncResident = useCallback(() => setResident([...rooms.keys()]), [rooms]);

  /* ---------------------------------------------------------------- */
  /* Visibility                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * Use the SDK's setVisible, NOT mesh.visible.
   *
   * mesh.visible skips only the draw call — you keep paying to depth-sort the
   * room every single frame. setVisible marks the config dirty and drops the
   * room from the render list and the sort passes entirely. With five
   * prefetched neighbours that is the difference between free and expensive.
   */
  const setRoomVisible = useCallback((entry, visible) => {
    entry.visible = visible;
    entry.renderer?.setVisible?.(visible);
    entry.renderer?.setDepthSorting?.(visible);
  }, []);

  /* ---------------------------------------------------------------- */
  /* Load / evict                                                     */
  /* ---------------------------------------------------------------- */

  const loadRoom = useCallback(
    (roomId, { visible }) => {
      const existing = rooms.get(roomId);
      if (existing) {
        existing.lastUsed = ++tick.current;
        setRoomVisible(existing, visible);
        return existing;
      }

      const entry = {
        renderer: null,
        mesh: null,
        state: 'loading',
        lastUsed: ++tick.current,
        visible,
        t0: performance.now()
      };
      rooms.set(roomId, entry);

      entry.renderer = LCCRender.load(
        buildLoadOptions({
          camera, scene, renderer: gl, canvas: gl.domElement, THREE,
          dataPath: metaPath(roomId),
          modelMatrix: LCC_MODEL_MATRIX,
          appKey,
          visible,
          tier,
          dev
        }),
        // onLoaded receives the THREE mesh. The load() RETURN VALUE is the
        // renderer, which carries hasCollision/intersectsCapsule/setVisible.
        // Two different objects; you need both.
        (mesh) => {
          entry.mesh = mesh;
          entry.state = 'ready';
          entry.loadMs = Math.round(performance.now() - entry.t0);
          setRoomVisible(entry, entry.visible);
          if (dev) {
            console.log(
              `[rooms] ${roomId} ready in ${entry.loadMs}ms`,
              `collision=${!!entry.renderer?.hasCollision?.()}`
            );
          }
        },
        (p) => { if (entry.visible) setProgress(p); },
        () => {
          entry.state = 'error';
          console.error(`[rooms] "${roomId}" failed — ${metaPath(roomId)}`);
        }
      );

      syncResident();
      return entry;
    },
    [camera, scene, gl, appKey, tier, dev, rooms, setRoomVisible, syncResident]
  );

  /**
   * LRU eviction. `keep` is the active room plus its neighbours — anything
   * outside that set is a candidate, oldest-touched first.
   *
   * unload() calls destroyRenderer() internally, which is what actually
   * releases GPU memory. Removing the mesh from the scene graph alone does not.
   */
  const evict = useCallback(
    (keep) => {
      const candidates = [...rooms.entries()]
        .filter(([id]) => !keep.has(id))
        .sort((a, b) => a[1].lastUsed - b[1].lastUsed);

      let over = rooms.size - budget;
      for (const [id, entry] of candidates) {
        if (over <= 0) break;
        if (entry.renderer) LCCRender.unload(entry.renderer);
        if (entry.mesh?.parent) entry.mesh.parent.remove(entry.mesh);
        rooms.delete(id);
        over--;
        if (dev) console.log(`[rooms] evicted ${id}`);
      }
      syncResident();
    },
    [rooms, budget, dev, syncResident]
  );

  /* ---------------------------------------------------------------- */
  /* Transitions                                                      */
  /* ---------------------------------------------------------------- */

  const enterRoom = useCallback(
    (roomId, { from = null } = {}) => {
      if (!NEIGHBOURS[roomId]) {
        console.error(`[rooms] unknown room "${roomId}"`);
        return;
      }

      clearTimeout(prefetchTimer.current);
      setTransitioning(true);
      setProgress(0);

      for (const [id, entry] of rooms) setRoomVisible(entry, id === roomId);

      const entry = loadRoom(roomId, { visible: true });

      // Where does the visitor land? Through a door -> that door's authored
      // spawn. Cold start -> the room default.
      const { spawn, yaw } = from
        ? arrival(from, roomId)
        : { spawn: DEFAULT_SPAWN, yaw: 0 };

      camera.position.set(...spawn);

      // Far plane per room. A far plane bigger than the scene means the frustum
      // test rejects nothing, which disables stage-1 culling entirely.
      tuneCameraForRoom(camera, { outdoor: !!ROOMS[roomId].outdoor, tier });

      setActive(roomId);

      if (entry.state === 'ready') {
        setProgress(1);
        setTransitioning(false);
      } else {
        // Poll rather than re-registering callbacks on an in-flight load —
        // the SDK takes its callbacks once, at load() time.
        const poll = setInterval(() => {
          if (entry.state !== 'loading') {
            clearInterval(poll);
            setTransitioning(false);
          }
        }, 100);
      }

      // Warm the neighbours AFTER the current room settles, so prefetch never
      // competes for bandwidth with the load the visitor is waiting on.
      prefetchTimer.current = setTimeout(() => {
        const ns = NEIGHBOURS[roomId];
        const keep = new Set([roomId, ...ns]);

        // Budget-aware: prefetch until full, nearest doors first.
        for (const n of ns) {
          if (rooms.size >= budget) break;
          loadRoom(n, { visible: false });
        }
        evict(keep);
      }, 900);

      return { yaw };
    },
    [camera, rooms, budget, tier, loadRoom, evict, setRoomVisible]
  );

  /* ---------------------------------------------------------------- */

  useEffect(() => {
    enterRoom(ENTRY_ROOM);
    return () => {
      clearTimeout(prefetchTimer.current);
      LCCRender.dispose();
      rooms.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeEntry = active ? rooms.get(active) : null;

  return {
    active,
    activeName: active ? ROOMS[active].name : '',
    transitioning,
    progress,
    resident,
    tier,
    budget,
    enterRoom,
    neighbours: active ? NEIGHBOURS[active] : [],
    /** Pass to the walker so it only collides with the visible room. */
    activeRenderer: activeEntry?.state === 'ready' ? activeEntry.renderer : null,
    stats: () => ({
      tier,
      budget,
      resident: rooms.size,
      renderers: LCCRender.getAllRenderers?.()?.length ?? 0,
      drawCalls: gl.info.render.calls,
      textures: gl.info.memory.textures,
      geometries: gl.info.memory.geometries,
      far: camera.far,
      loadTimes: Object.fromEntries([...rooms].map(([id, e]) => [id, e.loadMs ?? null]))
    })
  };
}
