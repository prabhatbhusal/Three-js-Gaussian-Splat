import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { LCCRender } from './vendor/sdk/lcc-web-sdk.js';
import { authorSpawn, dumpAuthored } from './doors.js';

const DEFAULTS = {
  eyeHeight: 1.65,   // metres — LCC scenes are metric, so real-world numbers work
  radius: 0.32,
  walkSpeed: 3.2,
  runSpeed: 6.4,
  gravity: -18,
  jumpVelocity: 6.2,
  lookSensitivity: 0.0022
};

/**
 * First-person walker driven by the SDK's capsule sweep.
 *
 * HOW THE COLLISION WORKS, because this is the part with no tutorial anywhere:
 *
 *   renderer.intersectsCapsule({ start, end, radius }) -> { hit, delta }
 *
 * `delta` is a push-out correction vector: "you are inside geometry, move by
 * this much to be outside it". That is called depenetration, and it is the
 * entire basis of a character controller. You do not need a physics engine —
 * you need to move, then ask "am I inside something?", then apply the delta.
 *
 * A mostly-upward delta (delta.y > 0) means the surface pushing you out is
 * beneath you, which means you landed. That is your grounded test.
 *
 * TWO RULES THAT ARE NOT OBVIOUS:
 *
 * 1. Resolve horizontal and vertical movement in SEPARATE passes. If you move
 *    diagonally and resolve once, a wall scuffed while falling produces a delta
 *    with both a sideways and an upward component, and the player gets launched
 *    along the wall. Two passes keeps the axes independent.
 *
 * 2. Clamp delta time. A backgrounded tab returns a 3-second frame. At -18 m/s²
 *    that is 54 m of fall in one step, straight through the floor, because the
 *    capsule never overlapped the geometry at any sampled position. This is
 *    tunnelling, and clamping is the cheap fix.
 */
export function useLccWalker({ renderer, enabled = true, roomId, options = {} }) {
  const opts = { ...DEFAULTS, ...options };
  const { camera, gl } = useThree();

  const keys = useRef(new Set());
  const look = useRef({ yaw: 0, pitch: 0 });
  const vel = useRef(new THREE.Vector3());
  const grounded = useRef(false);
  const locked = useRef(false);

  // Refs, not state. Anything you setState at 60fps re-renders the tree 60
  // times a second.
  const rendererRef = useRef(renderer);
  rendererRef.current = renderer;
  const roomRef = useRef(roomId);
  roomRef.current = roomId;

  // Preallocated scratch — allocating inside useFrame is how you get GC hitches.
  const v = useRef({
    start: new THREE.Vector3(),
    end: new THREE.Vector3(),
    fwd: new THREE.Vector3(),
    right: new THREE.Vector3(),
    wish: new THREE.Vector3()
  }).current;

  /* ---------------------------------------------------------------- */
  /* Input                                                            */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    const el = gl.domElement;

    const onKeyDown = (e) => {
      keys.current.add(e.code);
      if (e.code === 'Space') e.preventDefault();

      // Spawn authoring: walk to a door's landing spot, face the right way,
      // press P. Shift+P dumps everything authored this session.
      if (e.code === 'KeyP' && locked.current) {
        if (e.shiftKey) dumpAuthored();
        else authorSpawn(roomRef.current, camera, look.current.yaw);
      }
    };
    const onKeyUp = (e) => keys.current.delete(e.code);

    const onMouseMove = (e) => {
      if (!locked.current) return;
      look.current.yaw -= e.movementX * opts.lookSensitivity;
      look.current.pitch -= e.movementY * opts.lookSensitivity;
      const lim = Math.PI / 2 - 0.05;
      look.current.pitch = Math.max(-lim, Math.min(lim, look.current.pitch));
    };

    const onClick = () => el.requestPointerLock();
    const onLock = () => {
      locked.current = document.pointerLockElement === el;
      if (!locked.current) keys.current.clear();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('mousemove', onMouseMove);
    el.addEventListener('click', onClick);
    document.addEventListener('pointerlockchange', onLock);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('mousemove', onMouseMove);
      el.removeEventListener('click', onClick);
      document.removeEventListener('pointerlockchange', onLock);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, camera]);

  /* ---------------------------------------------------------------- */
  /* Depenetration                                                    */
  /* ---------------------------------------------------------------- */

  function resolve(pos) {
    const r = rendererRef.current;
    if (!r?.intersectsCapsule) return;

    // The capsule spans ankles to just below the eyes.
    v.start.set(pos.x, pos.y - opts.eyeHeight + opts.radius, pos.z);
    v.end.set(pos.x, pos.y - opts.radius, pos.z);

    const hit = r.intersectsCapsule({
      start: { x: v.start.x, y: v.start.y, z: v.start.z },
      end: { x: v.end.x, y: v.end.y, z: v.end.z },
      radius: opts.radius
    });

    if (!hit?.hit || !hit.delta) return;

    pos.x += hit.delta.x;
    pos.y += hit.delta.y;
    pos.z += hit.delta.z;

    if (hit.delta.y > 0.001) {
      grounded.current = true;
      if (vel.current.y < 0) vel.current.y = 0;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Frame                                                            */
  /* ---------------------------------------------------------------- */

  useFrame((_, raw) => {
    const dt = Math.min(raw, 0.05); // tunnelling guard — see rule 2 above

    if (enabled && locked.current) {
      const r = rendererRef.current;
      const hasColl = !!r?.hasCollision?.();

      camera.rotation.set(0, 0, 0);
      camera.rotateY(look.current.yaw);
      camera.rotateX(look.current.pitch);

      v.fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
      v.right.set(1, 0, 0).applyQuaternion(camera.quaternion);
      // Flatten movement onto the ground plane when walking; keep it free when
      // flying, so a look-up still moves you up.
      if (hasColl) { v.fwd.y = 0; v.right.y = 0; }
      v.fwd.normalize();
      v.right.normalize();

      const k = keys.current;
      v.wish.set(0, 0, 0);
      if (k.has('KeyW')) v.wish.add(v.fwd);
      if (k.has('KeyS')) v.wish.sub(v.fwd);
      if (k.has('KeyD')) v.wish.add(v.right);
      if (k.has('KeyA')) v.wish.sub(v.right);
      if (v.wish.lengthSq() > 0) v.wish.normalize();

      const speed = k.has('ShiftLeft') || k.has('ShiftRight') ? opts.runSpeed : opts.walkSpeed;

      if (!hasColl) {
        // No Collision.lci in this export — fly instead of falling forever.
        camera.position.addScaledVector(v.wish, speed * dt);
        if (k.has('Space')) camera.position.y += speed * dt;
      } else {
        if (grounded.current && k.has('Space')) {
          vel.current.y = opts.jumpVelocity;
          grounded.current = false;
        }
        vel.current.y = Math.max(vel.current.y + opts.gravity * dt, -55);
        grounded.current = false;

        camera.position.addScaledVector(v.wish, speed * dt); // pass 1: horizontal
        resolve(camera.position);

        camera.position.y += vel.current.y * dt;              // pass 2: vertical
        resolve(camera.position);
      }
    }

    // MANDATORY. Drives frustum culling, LOD selection, fetch priority and
    // depth sorting. Default priority (0) so R3F still auto-renders after this.
    LCCRender.update();
  });

  return {
    locked,
    grounded: () => grounded.current,
    yaw: () => look.current.yaw,
    setYaw: (y) => { look.current.yaw = y; },
    reset: (spawn, yaw = 0) => {
      camera.position.set(...spawn);
      look.current.yaw = yaw;
      look.current.pitch = 0;
      vel.current.set(0, 0, 0);
    }
  };
}

/** Screen-space pick against the splats. Returns { point, normal } or null. */
export const lccPick = (x, y, maxDistance = 40, radius = 0.05) =>
  LCCRender.raycast({ evt: { x, y }, maxDistance, radius });

/** Arbitrary ray — ground probes, line of sight, prop auto-placement. */
export const lccPickRay = (origin, direction, maxDistance = 40, radius = 0.05) =>
  LCCRender.raycastFromOrigin({ origin, direction, maxDistance, radius });
