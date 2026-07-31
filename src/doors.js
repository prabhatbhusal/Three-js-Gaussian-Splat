/**
 * Rooms, doors, and door spawn points.
 *
 * A door is not just "these two rooms connect". To teleport a visitor you need
 * to know WHERE they arrive and WHICH WAY they face, in the destination room's
 * own coordinate space. Each room was scanned separately, so every room has its
 * own origin — there is no shared frame to compute this from. It has to be
 * authored once, by walking there and recording it.
 *
 * `authorSpawn()` at the bottom does the recording. Press P in-game.
 */

const basePath = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
export const ASSET_ROOT = basePath ? `${basePath}/assets/rooms` : '/assets/rooms';
export const ENTRY_ROOM = 'outdoor';

/**
 * The meta filename inside each room folder.
 *
 * This matters more than it looks. LCC2 detection in the SDK is purely
 * extension-based:
 *
 *   const isLcc2 = (p) => new URL(p).pathname.endsWith('.lcc2');
 *
 * and the result picks an entirely different renderer class. For LCC2 the SDK
 * then splits the filename off the path and treats the remainder as the base
 * directory, logging `metaName: [...]` so you can confirm what it parsed.
 *
 * So: if this string does not end in `.lcc2`, you silently get the old LCC
 * code path against LCC2 data. Set it to your real filename — LCC2 exports
 * sometimes name the file after the scene rather than "meta".
 */
export const META_FILE = 'meta.lcc2';

export const ROOMS = {
  outdoor:             { name: 'Outdoor Building',           outdoor: true },
  floor1:              { name: 'Floor 1' },
  floor2:              { name: 'Floor 2' },
  floor3:              { name: 'Floor 3' },
  floor4:              { name: 'Floor 4' },
  floor5:              { name: 'Floor 5' },
  library:             { name: 'Library' },
  'geomatics-store':   { name: 'Geomatics Storeroom' },
  'computer-lab':      { name: 'Computer Lab' },
  'digital-classroom': { name: 'Digital Classroom' },
  'house-keeping-lab': { name: 'House Keeping Lab' },
  'bar-restro':        { name: 'Bar Restro' },
  kitchen:             { name: 'Kitchen' },
  'mechanical-lab':    { name: 'Engineering Mechanical Lab' },
  'physics-lab':       { name: 'Physics Lab' },
  'chemistry-lab':     { name: 'Chemistry Lab' },
  'veterinary-lab':    { name: 'Veterinary Lab' }
  // Per-room override when one export used a different filename:
  //   floor3: { name: 'Floor 3', meta: 'Floor3_scene.lcc2' },
};

/**
 * The 17 doors. `spawn` is where you land in the far room, `yaw` which way you
 * face (radians). Both null until authored — the manager falls back to the room
 * default and logs a warning, so an unauthored door still works, just badly.
 *
 * Each entry is bidirectional: `aSpawn` is where you arrive when entering
 * room A from room B, and vice versa.
 */
export const DOORS = [
  { a: 'floor1',         b: 'floor2',            aSpawn: null, aYaw: null, bSpawn: null, bYaw: null, label: 'Stairs' },
  { a: 'floor1',         b: 'outdoor',           aSpawn: null, aYaw: null, bSpawn: null, bYaw: null, label: 'Main entrance' },
  { a: 'floor2',         b: 'library',           aSpawn: null, aYaw: null, bSpawn: null, bYaw: null },
  { a: 'floor2',         b: 'geomatics-store',   aSpawn: null, aYaw: null, bSpawn: null, bYaw: null },
  { a: 'floor2',         b: 'computer-lab',      aSpawn: null, aYaw: null, bSpawn: null, bYaw: null },
  { a: 'floor2',         b: 'floor3',            aSpawn: null, aYaw: null, bSpawn: null, bYaw: null, label: 'Stairs' },
  { a: 'floor3',         b: 'digital-classroom', aSpawn: null, aYaw: null, bSpawn: null, bYaw: null },
  { a: 'floor3',         b: 'floor4',            aSpawn: null, aYaw: null, bSpawn: null, bYaw: null, label: 'Stairs' },
  { a: 'floor4',         b: 'house-keeping-lab', aSpawn: null, aYaw: null, bSpawn: null, bYaw: null },
  { a: 'floor4',         b: 'bar-restro',        aSpawn: null, aYaw: null, bSpawn: null, bYaw: null },
  { a: 'floor4',         b: 'kitchen',           aSpawn: null, aYaw: null, bSpawn: null, bYaw: null },
  { a: 'floor4',         b: 'floor5',            aSpawn: null, aYaw: null, bSpawn: null, bYaw: null, label: 'Stairs' },
  { a: 'bar-restro',     b: 'kitchen',           aSpawn: null, aYaw: null, bSpawn: null, bYaw: null, label: 'Service door' },
  { a: 'outdoor',        b: 'mechanical-lab',    aSpawn: null, aYaw: null, bSpawn: null, bYaw: null },
  { a: 'mechanical-lab', b: 'physics-lab',       aSpawn: null, aYaw: null, bSpawn: null, bYaw: null },
  { a: 'mechanical-lab', b: 'chemistry-lab',     aSpawn: null, aYaw: null, bSpawn: null, bYaw: null },
  { a: 'mechanical-lab', b: 'veterinary-lab',    aSpawn: null, aYaw: null, bSpawn: null, bYaw: null }
];

export const DEFAULT_SPAWN = [1, 3, 0];

/* ------------------------------------------------------------------ */
/* Paths                                                              */
/* ------------------------------------------------------------------ */

/**
 * Must return an ABSOLUTE url.
 *
 * The SDK calls `new URL(dataPath)` with no base argument, purely to sniff the
 * extension. `new URL('/assets/...')` throws "Failed to construct 'URL':
 * Invalid URL" — which surfaces as a crash inside the LCCRender constructor,
 * not as a helpful path error.
 */
export const metaPath = (roomId) => {
  const room = ROOMS[roomId];
  if (!room) throw new Error(`[doors] unknown roomId "${roomId}"`);
  return new URL(`${ASSET_ROOT}/${roomId}/${room.meta ?? META_FILE}`, location.origin).href;
};

/** True if this project is on the LCC2 code path. Passed through as useLcc2. */
export const isLcc2 = () => META_FILE.endsWith('.lcc2');

/* ------------------------------------------------------------------ */
/* Derived lookups — built once at module load                        */
/* ------------------------------------------------------------------ */

/** roomId -> [neighbourIds]. This is the prefetch prediction. */
export const NEIGHBOURS = (() => {
  const g = Object.fromEntries(Object.keys(ROOMS).map((id) => [id, []]));
  for (const d of DOORS) {
    g[d.a].push(d.b);
    g[d.b].push(d.a);
  }
  return g;
})();

/** "floor2->library" -> { spawn, yaw }. Where you land going from A to B. */
export const ARRIVALS = (() => {
  const m = {};
  for (const d of DOORS) {
    m[`${d.a}->${d.b}`] = { spawn: d.bSpawn, yaw: d.bYaw, label: d.label };
    m[`${d.b}->${d.a}`] = { spawn: d.aSpawn, yaw: d.aYaw, label: d.label };
  }
  return m;
})();

export function arrival(fromRoom, toRoom) {
  const key = `${fromRoom}->${toRoom}`;
  const a = ARRIVALS[key];
  if (!a) {
    console.error(`[doors] no door between "${fromRoom}" and "${toRoom}"`);
    return { spawn: DEFAULT_SPAWN, yaw: 0 };
  }
  if (!a.spawn) {
    console.warn(`[doors] "${key}" has no authored spawn — using room default. Press P there to author it.`);
    return { spawn: DEFAULT_SPAWN, yaw: 0 };
  }
  return { spawn: a.spawn, yaw: a.yaw ?? 0 };
}

/* ------------------------------------------------------------------ */
/* Validation — run once in dev, catches typos before a black screen   */
/* ------------------------------------------------------------------ */

export function validateGraph() {
  const problems = [];

  if (!/\.(lcc|lcc2)$/.test(META_FILE)) {
    problems.push(`META_FILE "${META_FILE}" ends in neither .lcc nor .lcc2 — the SDK will not detect the format`);
  }

  for (const d of DOORS) {
    if (!ROOMS[d.a]) problems.push(`door references unknown room "${d.a}"`);
    if (!ROOMS[d.b]) problems.push(`door references unknown room "${d.b}"`);
  }

  for (const [id, ns] of Object.entries(NEIGHBOURS)) {
    if (!ns.length) problems.push(`"${id}" has no doors — unreachable`);
  }

  // Breadth-first from the entry room: everything must be walkable.
  const seen = new Set([ENTRY_ROOM]);
  const q = [ENTRY_ROOM];
  while (q.length) {
    for (const n of NEIGHBOURS[q.shift()] ?? []) {
      if (!seen.has(n)) { seen.add(n); q.push(n); }
    }
  }
  for (const id of Object.keys(ROOMS)) {
    if (!seen.has(id)) problems.push(`"${id}" unreachable from "${ENTRY_ROOM}"`);
  }

  const unauthored = Object.entries(ARRIVALS).filter(([, v]) => !v.spawn).length;
  if (unauthored) {
    problems.push(`${unauthored}/${Object.keys(ARRIVALS).length} door arrivals have no spawn point yet`);
  }

  return problems;
}

/**
 * HEAD every room's meta file and report which ones resolve. Cheap, and it
 * turns a silent black screen into a list of exactly which folders are wrong.
 * Call once in dev; it does not block rendering.
 */
export async function probeRooms() {
  const results = await Promise.all(
    Object.keys(ROOMS).map(async (id) => {
      const url = metaPath(id);
      try {
        const r = await fetch(url, { method: 'HEAD' });
        return { id, ok: r.ok, status: r.status };
      } catch (e) {
        return { id, ok: false, status: 'network error' };
      }
    })
  );

  const bad = results.filter((r) => !r.ok);
  if (!bad.length) {
    console.log(`[doors] all ${results.length} room meta files resolve (${META_FILE})`);
  } else {
    console.warn(`[doors] ${bad.length}/${results.length} rooms missing "${META_FILE}":`);
    bad.forEach((r) => console.warn(`  · ${r.id} -> ${r.status}  ${metaPath(r.id)}`));
    console.warn('  Check the folder name and the actual filename inside it.');
  }
  return results;
}

/* ------------------------------------------------------------------ */
/* Spawn authoring                                                    */
/* ------------------------------------------------------------------ */

const authored = [];

/**
 * Call this when the visitor presses P. Walk to where a door should deposit
 * arrivals, face the direction they should look, press P, and this prints a
 * paste-ready line for DOORS above.
 *
 * This is the crudest possible authoring tool and it is the right one: 17 doors
 * takes half an hour, and doing it by hand tells you exactly what your real
 * editor needs to automate later.
 */
export function authorSpawn(roomId, camera, yaw) {
  const p = camera.position;
  const rec = {
    room: roomId,
    spawn: [round(p.x), round(p.y), round(p.z)],
    yaw: round(yaw)
  };
  authored.push(rec);

  console.log(
    `%c[spawn] ${roomId}`,
    'color:#2f6f4f;font-weight:bold',
    `\n  Spawn: [${rec.spawn.join(', ')}]  Yaw: ${rec.yaw}`,
    `\n  Paste into the matching door as either aSpawn/aYaw or bSpawn/bYaw.`
  );
  return rec;
}

/** Dump everything authored this session as JSON you can save. */
export function dumpAuthored() {
  const json = JSON.stringify(authored, null, 2);
  console.log(json);
  navigator.clipboard?.writeText(json).then(
    () => console.log('[spawn] copied to clipboard'),
    () => {}
  );
  return authored;
}

const round = (n) => Math.round(n * 100) / 100;