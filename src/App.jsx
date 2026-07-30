import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import * as THREE from 'three';
import { useRoomManager } from './useRoomManager.js';
import { useLccWalker } from './useLccWalker.js';
import { DebugHud } from './DebugHud.jsx';
import { ROOMS, validateGraph, probeRooms } from './doors.js';
import './hud.css';

/* ------------------------------------------------------------------ */
/* Inside the Canvas                                                  */
/* ------------------------------------------------------------------ */

function Tour({ onState }) {
  const manager = useRoomManager({ dev: import.meta.env.DEV });
  const walker = useLccWalker({
    renderer: manager.activeRenderer,
    roomId: manager.active,
    enabled: !manager.transitioning
  });

  const walkerRef = useRef(walker);
  walkerRef.current = walker;
  const managerRef = useRef(manager);
  managerRef.current = manager;

  /**
   * Travel through a door.
   *
   * enterRoom returns the ARRIVAL spawn for this specific door, so the walker
   * must be reset to that — not to a hardcoded origin. Getting this wrong is
   * why you would land in the same spot in every room.
   */
  const go = (roomId) => {
    const m = managerRef.current;
    if (!m || m.transitioning) return;
    if (!m.neighbours.includes(roomId)) {
      console.warn(`[tour] no door from "${m.active}" to "${roomId}"`);
      return;
    }
    const res = m.enterRoom(roomId, { from: m.active });
    walkerRef.current.reset(res?.spawn ?? [0, 2, 0], res?.yaw ?? 0);
  };

  const goRef = useRef(go);
  goRef.current = go;

  /**
   * Number keys 1-9 pick a door. This is the important bit: keydown on `window`
   * fires while pointer lock is active, whereas a DOM button click cannot —
   * the pointer is captured by the canvas.
   */
  useEffect(() => {
    const onKey = (e) => {
      const m = managerRef.current;
      if (!m || m.transitioning) return;

      const n = e.code.startsWith('Digit') ? Number(e.code.slice(5)) : NaN;
      if (n >= 1 && n <= m.neighbours.length) {
        e.preventDefault();
        goRef.current(m.neighbours[n - 1]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Publish state to the DOM overlays. React context does not usefully cross
  // the Canvas boundary, so lift instead of trying to consume it outside.
  useEffect(() => {
    onState({
      active: manager.active,
      activeName: manager.activeName,
      transitioning: manager.transitioning,
      progress: manager.progress,
      neighbours: manager.neighbours,
      resident: manager.resident,
      tier: manager.tier,
      budget: manager.budget,
      stats: manager.stats,
      manager,
      go: (id) => goRef.current(id)
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manager.active, manager.transitioning, manager.progress, manager.resident, onState]);

  return null;
}

/* ------------------------------------------------------------------ */
/* DOM overlays                                                       */
/* ------------------------------------------------------------------ */

function Gate({ state }) {
  if (!state || !state.transitioning) return null;
  return (
    <div className="lcc-gate">
      <div>
        <p className="pct">{(state.progress * 100).toFixed(0)}%</p>
        <p className="msg">{state.activeName || 'Loading'}</p>
      </div>
    </div>
  );
}

/**
 * Doors list. Numbered, because the number key is the primary way to travel —
 * clicking only works after Esc releases the pointer.
 *
 * "ready" means the room is already resident from graph prefetch, so the
 * transition will be instant. "load" means it has to fetch first.
 */
function Doors({ state }) {
  if (!state || state.transitioning) return null;
  return (
    <div className="lcc-doors">
      <div className="lbl">Doors from {state.activeName}</div>
      {state.neighbours.map((id, i) => {
        const warm = state.resident.includes(id);
        return (
          <button key={id} onClick={() => state.go(id)} className={warm ? 'warm' : ''}>
            <span className="num">{i + 1}</span>
            <span className="nm">{ROOMS[id].name}</span>
            <span className="tag">{warm ? 'ready' : 'load'}</span>
          </button>
        );
      })}
    </div>
  );
}

function Keys() {
  return (
    <div className="lcc-keys">
      <b>Click</b> to capture mouse · <b>WASD</b> move · <b>Space</b> jump · <b>Shift</b> run<br />
      <b>1</b>–<b>9</b> take a door · <b>P</b> record spawn · <b>F3</b> stats · <b>Esc</b> release mouse
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Root                                                              */
/* ------------------------------------------------------------------ */

export default function App() {
  const [state, setState] = useState(null);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const problems = validateGraph();
    if (problems.length) {
      console.warn(`[graph] ${problems.length} issue(s):`);
      problems.forEach((p) => console.warn('  · ' + p));
    } else {
      console.log('[graph] 17 rooms, 17 doors, all reachable');
    }
    probeRooms();
  }, []);

  const onState = useMemo(() => (s) => setState(s), []);

  return (
    <div className="lcc-root">
      <Canvas
        frameloop="always"
        gl={{
          antialias: false,
          // The SDK never sets toneMapping, so it assumes the plain
          // WebGLRenderer default its own example uses. R3F defaults to ACES
          // filmic, which makes splats look washed out next to LCC Studio.
          toneMapping: THREE.NoToneMapping
        }}
        dpr={[1, 2]}
        camera={{ fov: 60, near: 0.1, far: 250, position: [0, 2, 0] }}
      >
        <Tour onState={onState} />
      </Canvas>

      <Gate state={state} />
      <Doors state={state} />
      <Keys />
      {state?.transitioning === false && <div className="lcc-crosshair" />}
      {state && <DebugHud stats={state.stats} roomManager={state.manager} />}
    </div>
  );
}