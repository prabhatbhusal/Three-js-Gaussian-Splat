/**
 * Optimized LCC load configuration.
 *
 * PROVENANCE: the option list below was recovered by reading the v0.6.1 bundle's
 * argument-parsing block directly. Only `useEnv`, `useIndexDB`,
 * `useLoadingEffect`, `modelMatrix` and `appKey` appear in the public README.
 * The rest are real and parsed, but undocumented — so they may change between
 * releases. Pin your SDK version, and A/B each flag on your own scans rather
 * than trusting this file blindly.
 *
 * Every default noted below is the SDK's actual default, taken from its
 * `"boolean" != typeof e.x || e.x` (default true) versus
 * `"boolean" == typeof e.x && e.x` (default false) patterns.
 */

/* ------------------------------------------------------------------ */
/* Device tiering                                                     */
/* ------------------------------------------------------------------ */

/**
 * The SDK already caps splat count by GPU tier on its own (NVIDIA <1050 -> 1M,
 * <2060 -> 2M, mobile lower, desktop up to 3M). It does NOT tier the cache
 * budgets from your side — those default internally, and overriding them is how
 * you stop a phone from thrashing.
 *
 * Minimum accepted for either cache option is 10 MB; anything lower is ignored.
 */
const MB = 1024 * 1024;

export function detectTier() {
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const cores = navigator.hardwareConcurrency ?? 4;
  const mem = navigator.deviceMemory ?? navigator.deviceMemory ?? 4; // GB, Chrome only
  const net = navigator.connection?.effectiveType ?? '4g';
  const saveData = !!navigator.connection?.saveData;

  if (saveData || net === 'slow-2g' || net === '2g') return 'minimal';
  if (mobile) return cores >= 8 && mem >= 6 ? 'mobile-high' : 'mobile-low';
  if (cores <= 4 || mem <= 4) return 'desktop-low';
  return 'desktop-high';
}

const TIERS = {
  minimal: {
    maxGpuCacheSize: 100 * MB,
    maxHostCacheSize: 120 * MB,
    maxConcurrentDownloads: 2,
    workerPerFrameRequests: 1,
    useEnv: false,
    farPlane: 120
  },
  'mobile-low': {
    maxGpuCacheSize: 150 * MB,
    maxHostCacheSize: 200 * MB,
    maxConcurrentDownloads: 3,
    workerPerFrameRequests: 2,
    useEnv: false,
    farPlane: 180
  },
  'mobile-high': {
    maxGpuCacheSize: 250 * MB,
    maxHostCacheSize: 400 * MB,
    maxConcurrentDownloads: 4,
    workerPerFrameRequests: 2,
    useEnv: true,
    farPlane: 250
  },
  'desktop-low': {
    maxGpuCacheSize: 400 * MB,
    maxHostCacheSize: 600 * MB,
    maxConcurrentDownloads: 6,
    workerPerFrameRequests: 3,
    useEnv: true,
    farPlane: 250
  },
  'desktop-high': {
    maxGpuCacheSize: 1024 * MB,
    maxHostCacheSize: 1536 * MB,
    maxConcurrentDownloads: 8,
    workerPerFrameRequests: 4,
    useEnv: true,
    farPlane: 350
  }
};

/** How many rooms may be resident at once, per tier. */
export const RESIDENCY_BUDGET = {
  minimal: 1,
  'mobile-low': 2,
  'mobile-high': 3,
  'desktop-low': 3,
  'desktop-high': 5
};

export const tierProfile = (tier = detectTier()) => TIERS[tier];

/* ------------------------------------------------------------------ */
/* The config builder                                                 */
/* ------------------------------------------------------------------ */

export function buildLoadOptions({
  camera,
  scene,
  renderer,
  canvas,
  THREE,
  dataPath,
  modelMatrix,
  appKey,
  visible = true,
  tier = detectTier(),
  occlusionCulling = false,
  dev = false
}) {
  const p = TIERS[tier];

  return {
    /* --- required --- */
    camera,
    scene,
    canvas,
    renderer,
    renderLib: THREE,
    dataPath,
    modelMatrix,

    /**
     * The SDK logs `Warning: No appKey provided to the WebSDK!` when this is
     * absent. It still runs, but the warning is a strong hint that a key is
     * expected for production use. Settle this in the reseller agreement.
     */
    appKey,

    /* --- caching: the single biggest lever on repeat visits --- */
    useIndexDB: true,               // default true. Persists tiles across sessions.
    maxGpuCacheSize: p.maxGpuCacheSize,
    maxHostCacheSize: p.maxHostCacheSize,

    /* --- network shaping --- */
    /**
     * maxConcurrentDownloads caps in-flight tile requests. Too high on a poor
     * connection and every request slows down together, so the chunk you are
     * looking at arrives late. Too low and you underuse the link. On Kathmandu
     * campus wifi, lower is usually better than higher.
     */
    maxConcurrentDownloads: p.maxConcurrentDownloads,
    /** Tiles handed to decode workers per frame. Higher = faster fill, more jank. */
    workerPerFrameRequests: p.workerPerFrameRequests,

    /* --- rendering --- */
    useEnv: p.useEnv,               // default true. Environment.bin is a whole extra stream.
    /**
     * Default FALSE in the SDK. For interiors this is the flag most likely to
     * win big, because walls occlude nearly everything. It is off by default,
     * which usually means "not fully proven" — so measure it per room and be
     * ready to turn it off if you see popping.
     */
    useOcclusionCulling: occlusionCulling,
    gpuAcceleration: true,          // default FALSE in the SDK. Turn it on.
    writeDepth: false,              // default false. Only needed to depth-composite meshes.
    useDefaultRenderLoop: true,     // default true

    /* --- presentation --- */
    useLoadingEffect: visible,      // default false. Only for the room being waited on.

    /* --- instrumentation: dev only, both are noisy --- */
    enableLoadingLog: dev,
    useLccPerf: dev,

    /* --- leave alone --- */
    useEPSG: true                   // default true; needed if your exports are georeferenced
  };
}

/* ------------------------------------------------------------------ */
/* Camera                                                             */
/* ------------------------------------------------------------------ */

/**
 * The highest-value single line in this file.
 *
 * A far plane of 20000 on an indoor room means the SDK's frustum test rejects
 * almost no chunks, so it requests the whole building. Interiors rarely need
 * more than a couple of hundred metres. Call this on every room entry.
 */
export function tuneCameraForRoom(camera, { outdoor = false, tier = detectTier() } = {}) {
  const p = TIERS[tier];
  camera.far = outdoor ? p.farPlane * 4 : p.farPlane;
  camera.near = 0.1;
  camera.fov = 60;                  // 90 sweeps in noticeably more chunks
  camera.updateProjectionMatrix();
}
