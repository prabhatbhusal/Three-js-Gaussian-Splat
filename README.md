# React Three Fiber + XGRIDS LCC Web SDK

Companion to the vanilla Three.js tutorial. Same SDK (**v0.6.1**), same verified
API — this covers what changes when React owns the render loop.

## Why the integration is clean

Two facts I confirmed in the SDK bundle:

1. **`lcc-web-sdk.js` imports Three zero times.** You inject it via
   `renderLib: THREE`. So there is no duplicate-Three problem, no peer-dependency
   version war, and no `resolve.dedupe` gymnastics for the SDK itself. Whatever
   Three instance R3F uses, hand it the same one.
2. **The SDK is pinned against Three r164** in its own examples folder. R3F v8
   and v9 both work with r164. If you are on a much newer Three, that is your
   most likely source of odd rendering, so test against r164 first.

## Setup

```bash
npm create vite@latest campus-tour -- --template react
cd campus-tour
npm i three@0.164.0 @react-three/fiber
```

The SDK is not on npm, so vendor it:

```bash
mkdir -p src/vendor public/assets
cp /path/to/lccsdk/sdk/lcc-web-sdk.js src/vendor/
# your scene folder — must contain meta.lcc
cp -r /path/to/MyCollege public/assets/
```

Files in this bundle:

```
src/vendor/lcc-web-sdk.js   the SDK (copy it in)
src/LccSplat.jsx            loader component + context + capability probe
src/useLccWalker.js         first-person controller + raycast helpers
src/App.jsx                 wiring, coins, HUD
src/hud.css
```

Vite's dev server handles byte-range requests, so streaming works out of the box.
In production make sure your host does too — Nginx does by default; some CDN
configs and Django's `static` serving in DEBUG mode do not.

## The five things that differ from vanilla

### 1. Never create your own renderer, scene, or camera

R3F owns all three. Pull them from `useThree()` and pass them straight in:

```js
const { scene, camera, gl } = useThree();

LCCRender.load({
  camera,
  scene,
  canvas: gl.domElement,
  renderer: gl,          // R3F calls it `gl`; the SDK wants `renderer`
  renderLib: THREE,
  dataPath,
  modelMatrix
}, onLoaded, onProgress, onError);
```

### 2. `LCCRender.update()` goes in a `useFrame` at default priority

```js
useFrame((_, delta) => {
  stepPlayer(Math.min(delta, 0.05));
  LCCRender.update();          // must be every frame
});
```

Keep the priority at the default `0`. **The moment any `useFrame` in your tree
uses a priority above 0, R3F stops auto-rendering and you become responsible for
calling `gl.render()` yourself.** People reach for a priority to force
`LCCRender.update()` to run last, then wonder why the screen went black. Instead
just put it at the bottom of a single `useFrame` callback, as `useLccWalker`
does.

### 3. The singleton will bite you in StrictMode

The SDK does this internally:

```js
load: function (opts, ...) { return instance || (instance = new Renderer(opts)); }
```

One instance per page, ever. In React 18 StrictMode, dev-mode double-mounting
calls `load()` twice — the second call hands back the first instance — and then
the first cleanup calls `dispose()` and kills the live renderer. Black screen,
only in dev, which is a miserable afternoon.

`LccSplat.jsx` guards it with a module-level mount token so only the newest
mount may dispose. If you still see it, drop `<StrictMode>` from `main.jsx`.

The same singleton means **HMR is unreliable** for this file. Expect to hard
reload after editing loader options.

### 4. Context does not help your DOM overlay

Your loading gate and HUD live outside `<Canvas>`, so they cannot consume a
context provided inside it. Two options: lift state up (what `App.jsx` does, via
an `onStatus` callback), or use a store like zustand, which is the idiomatic R3F
answer once this grows.

Do not put the HUD inside the Canvas with drei's `<Html>`. It re-renders inside
the frame loop and you will pay for it.

### 5. Keep splat state out of React state

Camera position, velocity, grounded flag — all refs, all mutated in `useFrame`.
Anything you `setState` at 60 fps will re-render your tree 60 times a second.
React state is for things a human changes: coin counts, active room, whether the
registration gate has been passed.

## Coordinate system, again

```js
export const LCC_MODEL_MATRIX = new THREE.Matrix4(
  -1, 0, 0, 0,
   0, 0, 1, 0,
   0, 1, 0, 0,
   0, 0, 0, 1
);
```

LCC is Z-up, Three is Y-up. Fix it on the model, not the camera — `camera.up` is
tempting and fights every controller you write afterwards. Scenes are metric, so
1 unit = 1 metre.

## API quick reference

Module level:

```js
LCCRender.load(opts, onLoaded, onProgress, onError)  // -> lccObj
LCCRender.update()                                   // every frame
LCCRender.setCamera(camera)                          // on camera swap
LCCRender.raycast({ evt: {x, y}, maxDistance, radius })
LCCRender.raycastFromOrigin({ origin, direction, maxDistance, radius })
LCCRender.unload(obj) / dispose() / clearIndexDB() / getVersion()
```

On the returned object:

```js
lccObj.hasCollision() / hasShcoef() / hasEnvironment()
lccObj.getBounds() / getMeta() / getLodInfos()
lccObj.intersectsCapsule({ start, end, radius })   // -> { hit, delta }
lccObj.intersectsSphere({ center, radius, noDelta })
lccObj.setAlpha(a) / setSmooth(v) / setPointsColor(c) / useEnvironment(b)
lccObj.setClipBox(box) / setClipPlane(plane, ...)
lccObj.setPosition(x,y,z) / setRotation(r) / setScale(s) / setModelMatrix(m)
```

`intersectsCapsule` returning a push-out `delta` is the whole character
controller. Resolve horizontal and vertical movement in **separate** passes —
one combined resolve flings the player sideways when they scuff a wall mid-fall.

## Is React the right call here?

For the **viewer you embed on client sites**, React buys you little. The vanilla
starter is one HTML file, loads faster, and has no reconciler between you and the
frame loop.

For the **editor** — the thing that replaces using Unity or UE to add gameplay
to an LCC — React earns its keep immediately: inspector panels, an object list,
undo/redo history, room graph editing, asset library, multiplayer presence UI.
That is a lot of stateful interface, and R3F's `TransformControls` wrapper plus
plain React state gets you Blender-style gizmos far faster than hand-rolled DOM.

So: vanilla for the runtime, React for the authoring tool. They can share the
same `LccSplat` module if you keep the walker and the gizmo logic separate.

## Next step

Wire your 17-door room graph into `LCCRender.unload()` + `load()` transitions
behind a fade. One React route per room, one shared `<Canvas>`, no page reloads —
that is the concrete thing Arrival.Space's separate per-room links cannot do.