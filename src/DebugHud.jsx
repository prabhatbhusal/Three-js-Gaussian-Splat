import { useEffect, useRef, useState } from 'react';

/**
 * Live instrumentation. Toggle with F3.
 *
 * The point of this component is that you stop guessing. Everything I told you
 * about streaming is observable in these four numbers, and a 4070 Ti Super hides
 * all of it unless you are looking.
 *
 * THE ONE TO WATCH: the textures graph.
 *
 *   rises then plateaus and oscillates  -> eviction is working
 *   climbs monotonically forever        -> LEAK. unload() is not releasing.
 *
 * A leak is not a tuning problem. Raising or lowering MAX_RESIDENT only changes
 * how long it takes to crash. Fix the eviction path instead.
 */

const HISTORY = 120; // ~2 minutes at 1 Hz

export function DebugHud({ stats, roomManager }) {
  const [open, setOpen] = useState(false);
  const [snap, setSnap] = useState(null);
  const history = useRef([]);
  const netRef = useRef({ lastCount: 0, bytes: 0, rate: 0 });

  useEffect(() => {
    const onKey = (e) => {
      if (e.code === 'F3') { e.preventDefault(); setOpen((v) => !v); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!open) return;

    const id = setInterval(() => {
      const s = stats();

      /**
       * Live tile fetch measurement, straight from the Resource Timing API.
       * This is what stage 3 of the pipeline is actually doing — every entry
       * here is one Range request against a Data.bin.
       */
      const entries = performance.getEntriesByType('resource')
        .filter((r) => r.name.includes('.bin') || r.name.includes('.lci'));

      const newOnes = entries.slice(netRef.current.lastCount);
      const newBytes = newOnes.reduce((a, r) => a + (r.transferSize || r.encodedBodySize || 0), 0);
      const avgMs = newOnes.length
        ? Math.round(newOnes.reduce((a, r) => a + r.duration, 0) / newOnes.length)
        : 0;

      netRef.current.lastCount = entries.length;
      netRef.current.bytes += newBytes;
      netRef.current.rate = newOnes.length;

      history.current.push(s.textures);
      if (history.current.length > HISTORY) history.current.shift();

      setSnap({
        ...s,
        tilesTotal: entries.length,
        tilesPerSec: newOnes.length,
        avgTileMs: avgMs,
        totalMB: (netRef.current.bytes / 1048576).toFixed(1)
      });
    }, 1000);

    return () => clearInterval(id);
  }, [open, stats]);

  if (!open) {
    return (
      <div style={S.hint}>F3 debug</div>
    );
  }

  const h = history.current;
  const max = Math.max(1, ...h);
  const trend = detectTrend(h);

  return (
    <div style={S.panel}>
      <div style={S.head}>
        <span>LCC streaming</span>
        <span style={S.dim}>F3 to close</span>
      </div>

      {!snap ? (
        <div style={S.dim}>sampling…</div>
      ) : (
        <>
          <Section title="Residency">
            <Row k="tier" v={snap.tier} />
            <Row k="rooms resident" v={`${snap.resident} / ${snap.budget}`}
                 warn={snap.resident > snap.budget} />
            <Row k="sdk renderers" v={snap.renderers}
                 warn={snap.renderers !== snap.resident}
                 note={snap.renderers !== snap.resident ? 'mismatch — unload not releasing' : ''} />
            <Row k="active" v={roomManager.activeName} />
            <Row k="prefetched" v={roomManager.neighbours.length} />
          </Section>

          <Section title="Pipeline stage 1 — culling">
            <Row k="camera.far" v={`${Math.round(snap.far)} m`}
                 warn={snap.far > 1000}
                 note={snap.far > 1000 ? 'frustum bigger than scene = culling disabled' : ''} />
          </Section>

          <Section title="Pipeline stage 3 — network">
            <Row k="tiles fetched" v={snap.tilesTotal} />
            <Row k="tiles / sec" v={snap.tilesPerSec} />
            <Row k="avg tile time" v={`${snap.avgTileMs} ms`}
                 warn={snap.avgTileMs > 400}
                 note={snap.avgTileMs > 400 ? 'check 206 support and CDN edge' : ''} />
            <Row k="total transferred" v={`${snap.totalMB} MB`} />
          </Section>

          <Section title="Pipeline stage 5 — draw">
            <Row k="draw calls" v={snap.drawCalls} />
            <Row k="geometries" v={snap.geometries} />
            <Row k="textures" v={snap.textures} />
          </Section>

          <div style={S.graphWrap}>
            <div style={S.graphLabel}>
              GPU textures over time
              <span style={{ ...S.badge, background: trend.color }}>{trend.label}</span>
            </div>
            <svg viewBox={`0 0 ${HISTORY} 40`} preserveAspectRatio="none" style={S.graph}>
              <polyline
                fill="none"
                stroke={trend.color}
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
                points={h.map((v, i) => `${i},${40 - (v / max) * 38}`).join(' ')}
              />
            </svg>
            <div style={S.dim}>{trend.hint}</div>
          </div>

          <Section title="Room load times">
            {Object.entries(snap.loadTimes).map(([id, ms]) => (
              <Row key={id} k={id} v={ms == null ? 'loading…' : `${ms} ms`} />
            ))}
          </Section>
        </>
      )}
    </div>
  );
}

/**
 * Linear regression on the texture history. A positive slope that never flattens
 * is the leak signature — that is the whole reason this component exists.
 */
function detectTrend(h) {
  if (h.length < 20) {
    return { label: 'warming up', color: '#8a8a8a', hint: 'walk between rooms for 20s' };
  }

  const n = h.length;
  const mx = (n - 1) / 2;
  const my = h.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - mx) * (h[i] - my);
    den += (i - mx) ** 2;
  }
  const slope = num / den;

  // Compare the last third against the middle third: a plateau means the
  // recent average stopped growing even if the overall slope is positive.
  const third = Math.floor(n / 3);
  const mid = avg(h.slice(third, third * 2));
  const late = avg(h.slice(third * 2));
  const plateaued = late <= mid * 1.05;

  if (slope > 0.5 && !plateaued) {
    return {
      label: 'LEAK',
      color: '#b4552d',
      hint: 'climbing without plateau — unload() is not releasing GPU memory'
    };
  }
  if (plateaued) {
    return { label: 'stable', color: '#2f6f4f', hint: 'plateaued — eviction is working' };
  }
  return { label: 'rising', color: '#c9a227', hint: 'still filling; keep walking' };
}

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/* --- presentational bits --- */

const Section = ({ title, children }) => (
  <div style={{ marginTop: 10 }}>
    <div style={S.sect}>{title}</div>
    {children}
  </div>
);

const Row = ({ k, v, warn, note }) => (
  <div>
    <div style={S.row}>
      <span style={S.dim}>{k}</span>
      <span style={{ color: warn ? '#b4552d' : '#f2efe6' }}>{v}</span>
    </div>
    {note ? <div style={S.note}>{note}</div> : null}
  </div>
);

const S = {
  hint: {
    position: 'fixed', bottom: 8, right: 8, zIndex: 20,
    font: '400 10px ui-monospace, Menlo, monospace',
    color: 'rgba(242,239,230,.35)', pointerEvents: 'none'
  },
  panel: {
    position: 'fixed', top: 12, right: 12, zIndex: 20, width: 300,
    maxHeight: 'calc(100vh - 24px)', overflowY: 'auto',
    background: 'rgba(13,17,23,.93)',
    border: '1px solid rgba(242,239,230,.18)',
    padding: '12px 14px',
    font: '400 11px/1.5 ui-monospace, Menlo, monospace',
    color: '#f2efe6', backdropFilter: 'blur(8px)'
  },
  head: {
    display: 'flex', justifyContent: 'space-between',
    letterSpacing: '.1em', textTransform: 'uppercase', fontSize: 10,
    paddingBottom: 8, borderBottom: '1px solid rgba(242,239,230,.14)'
  },
  sect: {
    fontSize: 9, letterSpacing: '.14em', textTransform: 'uppercase',
    color: 'rgba(242,239,230,.45)', marginBottom: 3
  },
  row: { display: 'flex', justifyContent: 'space-between', gap: 12 },
  dim: { color: 'rgba(242,239,230,.55)' },
  note: { color: '#b4552d', fontSize: 10, paddingLeft: 8 },
  graphWrap: { marginTop: 12, paddingTop: 10, borderTop: '1px solid rgba(242,239,230,.14)' },
  graphLabel: {
    fontSize: 9, letterSpacing: '.14em', textTransform: 'uppercase',
    color: 'rgba(242,239,230,.45)', display: 'flex',
    justifyContent: 'space-between', alignItems: 'center', marginBottom: 5
  },
  badge: { color: '#0d1117', padding: '1px 6px', fontSize: 9, letterSpacing: '.08em' },
  graph: { width: '100%', height: 40, display: 'block', marginBottom: 4 }
};
