# How LCC streaming actually works

Not a list of things to do. The mechanism, so you can reason about it yourself
and stop needing me for the next decision.

---

## 1. What is actually inside an LCC folder

```
meta.lcc          JSON. Bounds, LOD tiers, grid dimensions, EPSG code.
Index.bin         The chunk tree. Which splats live in which spatial cell,
                  at which LOD level, at which byte offset in Data.bin.
Data.bin          The splats themselves: position, rotation, scale, colour.
                  One big file, read in pieces.
Shcoef.bin        Optional. 3rd-order spherical harmonics (view-dependent
                  lighting). A whole second stream, roughly doubling bytes.
Environment.bin   Optional. Sky / surround.
Collision.lci     Optional. A chunk-aligned BVH for physics.
```

The important structural fact: **`Data.bin` is never downloaded whole.** It is
addressed by byte range. `Index.bin` tells the SDK "the splats for cell (4,2) at
LOD 3 are bytes 91,238,400 to 91,506,688", and the SDK issues:

```http
GET /assets/rooms/floor2/Data.bin
Range: bytes=91238400-91506687
```

This is why the `206 Partial Content` check is not pedantry. If your server
answers `200 OK` with the whole body, the SDK asked for 262 KB and got 400 MB,
then throws away 99.9% of it — and does that again for the next chunk. It still
*works*, which is what makes it so dangerous: you will never notice on your own
machine.

Verify it yourself:

```bash
curl -sI -H "Range: bytes=0-1023" https://host/assets/rooms/floor2/Data.bin
```

Look for `HTTP/1.1 206` and `Content-Length: 1024`. If you see the full file
size, that is your entire performance problem and nothing else matters.

---

## 2. What `LCCRender.update()` does, every frame

This is the loop you are actually optimizing. Reading it out of the bundle:

```js
const frustum = dynamicState.frustum;
node.distanceNear = node.bounds.containsPoint(cam)
  ? 0
  : node.bounds.distanceToPoint(cam);
node.lodEvaluateValue = /* screen-space error from distance + node size */;
node.priority = /* queue ordering */;
```

Five stages, in order:

**Stage 1 — Frustum test.** Walk the chunk tree, discard any node whose bounding
box is outside the camera frustum. This is where "load only what the user sees"
happens, and it is free — pure math, no network.

**Stage 2 — LOD evaluation.** For each surviving node, compute a screen-space
error from its distance and size. Far nodes resolve to a coarse tier (fewer
splats, fewer bytes); near nodes to a fine tier. One chunk therefore has several
possible byte ranges, and the camera picks which.

**Stage 3 — Priority queue.** Sort the wanted-but-missing chunks so the one you
are looking *at* is fetched before the one behind your shoulder.
`maxConcurrentDownloads` caps how many are in flight.

**Stage 4 — Decode.** Tiles land in web workers, get unpacked into GPU-ready
buffers. `workerPerFrameRequests` caps how many are handed over per frame — this
is the knob that trades fill speed against frame jank.

**Stage 5 — Sort and draw.** Gaussian splats must be depth-sorted every frame or
they composite wrong. This cost scales with *resident splat count*, not with
what is on screen.

Stage 5 is why `setVisible(false)` beats `mesh.visible = false`. `mesh.visible`
skips only stage 5's draw. `setVisible` removes the room from stages 1–5
entirely. On five prefetched neighbours that is the difference between free and
expensive.

---

## 3. Why the far plane is the biggest single line

Stage 1 discards nodes outside the frustum. The frustum's volume grows with the
**cube** of the far plane:

```
V ≈ (1/3) · far³ · tan²(fov/2) · aspect
```

Your current far plane is 20000. An interior room is maybe 40 m across.

```
far = 20000  →  V ∝ 8.0 × 10¹²
far = 250    →  V ∝ 1.6 × 10⁷
```

That is a factor of ~500,000 in frustum volume. In practice you do not get
500,000× fewer chunks, because the chunk tree ends at the building's bounds — but
you *do* go from "the frustum contains the entire scene, so stage 1 rejects
nothing and stages 2–4 consider every chunk" to "stage 1 rejects most of the
building immediately."

The mechanism to hold onto: **a far plane larger than your scene disables frustum
culling.** Not weakens — disables. The test still runs, and passes everything.

Field of view works the same way via `tan²(fov/2)`:

```
fov = 90  →  tan²(45°) = 1.00
fov = 60  →  tan²(30°) = 0.33
```

Three times less frustum volume, for free, and 60 looks better on a monitor
anyway.

---

## 4. Where each option lands in the pipeline

Now the twenty-two load options stop being a list and become a map:

| Stage | Option | What it changes |
|---|---|---|
| 1 Frustum | `camera.far`, `camera.fov` | how much survives culling |
| 1 Frustum | `useOcclusionCulling` | also discard chunks hidden *behind* geometry |
| 2 LOD | (internal `maxLoadSplatCount`) | auto-tiered by detected GPU |
| 3 Network | `maxConcurrentDownloads` | in-flight request cap |
| 3 Network | `useIndexDB` | skip the network entirely on revisit |
| 3 Network | `useEnv`, `useSH` | whether extra streams exist at all |
| 4 Decode | `workerPerFrameRequests` | fill speed vs frame jank |
| 4/5 Memory | `maxGpuCacheSize`, `maxHostCacheSize` | when tiles get evicted |
| 5 Draw | `gpuAcceleration` | default **false** — turn it on |
| 5 Draw | `setVisible`, `setDepthSorting` | remove a room from the loop |

`useOcclusionCulling` is interesting specifically for you because your scenes are
interiors. Frustum culling asks "is it in front of me?"; occlusion culling asks
"is a wall in the way?" In a corridor those give wildly different answers. It
defaults to false, and there are two sibling internal flags
(`useOcclusionCullingShader`, `useOcclusionCullingDepth`), which is the pattern
of a feature still being stabilised. So: measure it, per room, and watch for
chunks popping in late.

---

## 5. Why `maxConcurrentDownloads` should sometimes go *down*

This one is unintuitive, so here is the reasoning rather than the rule.

You have a fixed link — say 4 Mbps on campus wifi. Stage 3 has queued 40 chunks
by priority. Chunk #1 is the wall directly in front of the visitor.

With `maxConcurrentDownloads: 20`, twenty requests share the 4 Mbps. Chunk #1 now
gets 200 Kbps and takes 20× longer than if it had the link to itself. Chunks #1
through #20 all arrive at roughly the same late moment.

With `maxConcurrentDownloads: 3`, chunk #1 gets ~1.3 Mbps and lands quickly. The
visitor sees the wall in front of them resolve, then the next thing, then the
next.

**Total bytes are identical. Time-to-first-useful-pixel is not.** High concurrency
optimises throughput; low concurrency optimises the priority ordering that
stage 3 worked to compute. Since stage 3 already sorted by what the visitor is
looking at, you want to *respect* that ordering, and high concurrency destroys
it.

Corollary: raise it on fast connections where per-request latency dominates, lower
it on slow ones where bandwidth dominates. Which is exactly what
`connection.effectiveType` tells you, which is why the tiering in `lccConfig.js`
keys off it.

---

## 6. Why 17 rooms cannot all be resident

Per-room streaming adapts to the camera. Per-room *fixed* costs do not:

```
Index.bin        chunk tree, fully resident once loaded
Collision.lci    BVH, fully resident — physics can't stream on demand,
                 you may collide with anything at any moment
sort buffers     scratch space proportional to resident splats
```

Seventeen chunk trees plus seventeen BVHs is seventeen of each, regardless of
where the camera points. That is the part your residency budget controls, and the
part the SDK cannot help with because it does not know about your room graph.

The insight that makes prefetch work: **the door graph is a prediction.** From
Floor 2 the visitor can only reach Floor 1, Floor 3, Library, Geomatics Store, or
Computer Lab. Not Kitchen, not Physics Lab. So you know, with certainty, which
five scenes might be needed next — and loading exactly those is why the
transition feels seamless instead of like a page load.

That is graph-driven prefetch. It is not clever caching; it is reading the
adjacency list you already wrote.

---

## 7. How to see all of this

The debug overlay in the code (`DebugHud.jsx`, toggle with **F3**) reads:

```js
gl.info.render.calls        // draw calls this frame
gl.info.memory.textures     // GPU textures — THE leak indicator
LCCRender.getAllRenderers() // resident room count
performance.getEntriesByType('resource')  // live tile fetches, bytes, timing
```

The one to watch is `memory.textures` across a full walk. Walk Outdoor → Floor 1
→ 2 → 3 → 4 → 5 → Kitchen and back. Texture count should rise, plateau, and
oscillate around the plateau as rooms evict and load.

If it climbs monotonically, eviction is not releasing. That is a **leak**, not a
tuning problem, and adjusting `MAX_RESIDENT` will only change how long it takes
to crash. The overlay graphs it so you can see the difference at a glance.

---

## 8. The reasoning behind the work order

Not "do these in order" but why the order is what it is:

1. **Range requests** — a broken `206` multiplies every byte by ~1000×. No code
   change competes with a 1000× multiplier.
2. **CDN edge** — from Kathmandu, a US origin adds ~275 ms per request. Stage 3
   issues hundreds. That is a fixed, unavoidable 30–90 s of pure latency that no
   amount of frustum culling removes.
3. **Far plane** — one line, disables-vs-enables an entire pipeline stage.
4. **Options** — `gpuAcceleration` and caches: real, but percentage-level.
5. **Residency tuning** — matters only once 1–4 are done, because before that
   you are measuring the wrong bottleneck.

The general principle: **fix multipliers before you fix percentages.** Steps 1
and 2 are multipliers. Steps 3 onward are percentages.

---

## Files

| File | What it teaches |
|---|---|
| `src/lcc/lccConfig.js` | the option surface, tiered by device |
| `src/lcc/useRoomManager.js` | residency, LRU eviction, graph prefetch |
| `src/lcc/useLccWalker.js` | capsule collision against splats |
| `src/lcc/DebugHud.jsx` | live instrumentation — read this one carefully |
| `src/lcc/doors.js` | the graph, plus in-app spawn authoring |
| `src/App.jsx` | how it all wires together |
