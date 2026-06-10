import { useEffect, useState } from 'react';
import { perfMonitor } from '../../perf/perfMonitor';
import styles from './FpsMeter.module.css';

declare global {
  interface Window {
    /** Latest perf snapshot, exposed in dev for programmatic inspection. */
    __PERF__?: { fps: number; drawMs: number };
  }
}

/** Sample the monitor a few times a second (not per frame) to limit re-renders. */
const SAMPLE_INTERVAL_MS = 500;
/** Beacon to the dev server at this cadence (coarser, to keep the log readable). */
const REPORT_INTERVAL_MS = 1000;

/** Fire-and-forget perf beacon to the dev-only /__perf endpoint. */
function reportPerf(fps: number, drawMs: number): void {
  try {
    const body = JSON.stringify({ fps: Math.round(fps), drawMs: Number(drawMs.toFixed(2)) });
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/__perf', body);
    } else {
      void fetch('/__perf', { method: 'POST', body, keepalive: true });
    }
  } catch {
    // network unavailable; ignore.
  }
}

/**
 * Dev-only render meter. Shows draws-per-second and the smoothed per-draw cost,
 * exposes the latest values on window.__PERF__, and beacons them to the dev
 * server's stdout so live performance is observable from the terminal. Reads 0
 * when idle (the canvas deliberately doesn't draw when nothing changes).
 */
export function FpsMeter() {
  const [fps, setFps] = useState(0);
  const [drawMs, setDrawMs] = useState(0);

  useEffect(() => {
    let last = performance.now();
    let sinceReport = 0;

    const id = window.setInterval(() => {
      const now = performance.now();
      const nextFps = perfMonitor.takeFps(now - last);
      const nextDrawMs = perfMonitor.drawMs;
      last = now;

      setFps(nextFps);
      setDrawMs(nextDrawMs);
      window.__PERF__ = { fps: nextFps, drawMs: nextDrawMs };

      // Only beacon while active, to keep the terminal log free of idle noise.
      sinceReport += SAMPLE_INTERVAL_MS;
      if (sinceReport >= REPORT_INTERVAL_MS) {
        sinceReport = 0;
        if (nextFps > 0) reportPerf(nextFps, nextDrawMs);
      }
    }, SAMPLE_INTERVAL_MS);

    return () => window.clearInterval(id);
  }, []);

  return (
    <div className={styles.meter} aria-hidden="true">
      {Math.round(fps)} fps · {drawMs.toFixed(1)} ms
    </div>
  );
}
