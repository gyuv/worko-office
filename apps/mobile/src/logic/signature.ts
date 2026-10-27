export type Pt = { x: number; y: number };

const r1 = (n: number) => Math.round(n * 10) / 10;

/** One stroke → SVG path data, smoothed with quadratic curves through midpoints. A single tap draws a dot. */
export function strokeToPath(pts: Pt[]): string {
  if (!pts.length) return '';
  const [p0] = pts as [Pt];
  if (pts.length === 1) return `M${r1(p0.x)},${r1(p0.y)} L${r1(p0.x + 0.1)},${r1(p0.y + 0.1)}`;
  let d = `M${r1(p0.x)},${r1(p0.y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i]!, b = pts[i + 1]!;
    d += ` Q${r1(a.x)},${r1(a.y)} ${r1((a.x + b.x) / 2)},${r1((a.y + b.y) / 2)}`;
  }
  const last = pts[pts.length - 1]!;
  return d + ` L${r1(last.x)},${r1(last.y)}`;
}
export const strokesToPaths = (strokes: Pt[][]) => strokes.map(strokeToPath).filter(Boolean);
/** A signature needs some ink: at least `min` points in total. */
export const hasInk = (strokes: Pt[][], min = 5) => strokes.reduce((n, s) => n + s.length, 0) >= min;
