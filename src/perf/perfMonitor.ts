/**
 * Tiny render-profiler. The canvas only draws on demand (no idle rAF loop), so
 * "fps" here means *draws per second* — it reads ~your refresh rate while
 * interacting and 0 when idle, which is exactly the intended behaviour. `drawMs`
 * is the smoothed time spent inside a single draw, i.e. the frame budget used.
 */
class PerfMonitor {
  private drawCount = 0;
  /** Exponentially smoothed duration of the most recent draws, in ms. */
  drawMs = 0;

  recordDraw(durationMs: number): void {
    this.drawCount += 1;
    this.drawMs = this.drawMs === 0 ? durationMs : this.drawMs * 0.85 + durationMs * 0.15;
  }

  /** Draws-per-second over `elapsedMs`, resetting the counter for the next window. */
  takeFps(elapsedMs: number): number {
    const fps = elapsedMs > 0 ? (this.drawCount * 1000) / elapsedMs : 0;
    this.drawCount = 0;
    if (fps === 0) this.drawMs = 0; // idle: nothing drew this window
    return fps;
  }
}

export const perfMonitor = new PerfMonitor();
