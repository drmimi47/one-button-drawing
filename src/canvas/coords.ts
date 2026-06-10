import type { Camera } from '../types';

export interface Vec2 {
  x: number;
  y: number;
}

/**
 * Screen/world transforms for the camera. screen = world * scale + pan, so the
 * inverse is world = (screen - pan) / scale. Screen coordinates here are CSS
 * pixels relative to the canvas top-left.
 */
export function screenToWorld(screenX: number, screenY: number, camera: Camera): Vec2 {
  return {
    x: (screenX - camera.x) / camera.scale,
    y: (screenY - camera.y) / camera.scale,
  };
}

export function worldToScreen(worldX: number, worldY: number, camera: Camera): Vec2 {
  return {
    x: worldX * camera.scale + camera.x,
    y: worldY * camera.scale + camera.y,
  };
}
