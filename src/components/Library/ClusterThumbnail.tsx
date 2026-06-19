import { useEffect, useRef } from 'react';
import type { Square } from '../../types';
import { SHAPE_THEME, MAX_DEVICE_PIXEL_RATIO } from '../../constants';
import { drawClusterThumbnail } from '../../canvas/thumbnail';
import styles from './LibraryPanel.module.css';

/** A small canvas preview of a saved cluster, fitted to the element's box. */
export function ClusterThumbnail({ shapes }: { shapes: Square[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (cssW === 0 || cssH === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawClusterThumbnail(ctx, shapes, cssW, cssH, SHAPE_THEME);
  }, [shapes]);

  return <canvas ref={canvasRef} className={styles.thumbCanvas} aria-hidden="true" />;
}
