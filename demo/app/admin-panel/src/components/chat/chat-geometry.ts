/** Position (top-left, viewport px) and size of the floating chat window. */
export interface Geometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const MIN_WIDTH = 340;
export const MIN_HEIGHT = 420;

const DEFAULT_WIDTH = 420;
const DEFAULT_HEIGHT = 620;
const MARGIN = 24;

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), Math.max(min, max));

/** Bottom-right default sized to fit the current viewport. */
export function defaultGeometry(): Geometry {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.min(DEFAULT_WIDTH, viewportWidth - MARGIN * 2);
  const height = Math.min(DEFAULT_HEIGHT, viewportHeight - MARGIN * 2);
  return {
    width,
    height,
    x: Math.max(MARGIN, viewportWidth - width - MARGIN),
    y: Math.max(MARGIN, viewportHeight - height - MARGIN),
  };
}
