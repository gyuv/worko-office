import type { ReportGroup } from '@worko/domain';
import { useLayoutEffect, useRef, useState } from 'react';
import { formatAxis, formatCell, niceTicks, shares, type ChartData } from './logic';

/**
 * Lightweight SVG charts (no chart library). One series per chart, so one hue: the ui-tokens `primary` colour via its CSS
 * variable (both themes come from @worko/ui-tokens); grid/axes use `border`/`text-muted`, text never wears the series colour.
 * Marks follow the dataviz spec: thin bars with a 4px rounded data end on the baseline and 2px gaps, 2px lines, 8px markers,
 * hover tooltips with hit targets larger than the marks. The pie hint renders as share-of-total bars (part-to-whole in one
 * hue — no categorical palette exists in ui-tokens, and status colours are reserved).
 */
const C = { mark: 'var(--w-primary)', grid: 'var(--w-border)', muted: 'var(--w-text-muted)', text: 'var(--w-text)', surface: 'var(--w-surface)' };

function useWidth(fallback = 520) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const set = () => { if (el.clientWidth > 0) setW(el.clientWidth); };
    set();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(set); ro.observe(el); return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

type Props = { data: ChartData; onSelect?: (g: ReportGroup) => void; height?: number; label: string };

export function Chart(p: Props) {
  if (p.data.type === 'line') return <LineChart {...p} />;
  if (p.data.type === 'pie') return <ShareBars {...p} />;
  return <BarChart {...p} />;
}

function Tooltip({ x, y, title, value }: { x: number; y: number; title: string; value: string }) {
  return (
    <div role="tooltip" className="pointer-events-none absolute z-10 rounded-md border border-border bg-surface px-2 py-1 text-xs shadow" style={{ left: x, top: y, transform: 'translate(-50%, calc(-100% - 8px))' }}>
      <div className="text-muted">{title}</div><div className="font-semibold tabular-nums">{value}</div>
    </div>
  );
}

/** Horizontal bars: category labels read left, values from a 0 baseline. Click → drill. */
function BarChart({ data, onSelect, label }: Props) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const pts = data.points.slice(0, 24);
  const labelW = Math.min(160, Math.max(70, width * 0.3));
  const valueW = 72; const row = 26; const barH = 14; const top = 4;
  const max = Math.max(0, ...pts.map((x) => x.value));
  const ticks = niceTicks(max); const axisMax = ticks[ticks.length - 1] || 1;
  const plotW = Math.max(40, width - labelW - valueW);
  const sx = (v: number) => (Math.max(0, v) / axisMax) * plotW;
  const h = top + pts.length * row + 18;
  const showAll = pts.length <= 8;
  const maxIdx = pts.findIndex((x) => x.value === max);
  return (
    <div ref={ref} className="relative w-full">
      <svg width={width} height={h} role="img" aria-label={label}>
        {ticks.map((t) => <g key={t}><line x1={labelW + sx(t)} x2={labelW + sx(t)} y1={top} y2={h - 16} stroke={C.grid} strokeWidth={1} />
          <text x={labelW + sx(t)} y={h - 4} fontSize={10} textAnchor="middle" fill={C.muted}>{formatAxis(t, data.yType)}</text></g>)}
        {pts.map((pt, i) => {
          const y = top + i * row; const w = sx(pt.value); const r = Math.min(4, w / 2, barH / 2);
          const clickable = !!(onSelect && pt.group);
          return (
            <g key={`${pt.label}-${i}`} data-testid="chart-bar" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
              onClick={clickable ? () => onSelect!(pt.group!) : undefined} style={{ cursor: clickable ? 'pointer' : 'default' }}>
              <rect x={0} y={y} width={width} height={row} fill="transparent" />
              <text x={labelW - 6} y={y + row / 2 + 4} fontSize={11} textAnchor="end" fill={C.text}>{pt.label.length > 22 ? `${pt.label.slice(0, 21)}…` : pt.label}</text>
              {/* Square on the baseline, 4px round on the data end. */}
              {w > 0 && <path d={`M${labelW},${y + (row - barH) / 2} h${w - r} a${r},${r} 0 0 1 ${r},${r} v${barH - 2 * r} a${r},${r} 0 0 1 -${r},${r} h-${w - r} z`} fill={C.mark} opacity={hover === null || hover === i ? 1 : 0.55} />}
              {(showAll || i === maxIdx || hover === i) && <text x={labelW + w + 6} y={y + row / 2 + 4} fontSize={11} fill={C.muted} className="tabular-nums">{formatAxis(pt.value, data.yType)}</text>}
            </g>
          );
        })}
        <line x1={labelW} x2={labelW} y1={top} y2={h - 16} stroke={C.muted} strokeWidth={1} />
      </svg>
      {hover !== null && pts[hover] && <Tooltip x={labelW + sx(pts[hover]!.value) / 2} y={top + hover * row + 4} title={pts[hover]!.label} value={formatCell(pts[hover]!.value, data.yType)} />}
    </div>
  );
}

/** Line over ordered x (months/weeks/days): 2px line, 8px markers with a surface ring, crosshair + tooltip on the nearest point. */
function LineChart({ data, onSelect, label, height = 200 }: Props) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const pts = data.points;
  const left = 56; const right = 12; const top = 10; const bottom = 24;
  const max = Math.max(0, ...pts.map((x) => x.value));
  const ticks = niceTicks(max); const axisMax = ticks[ticks.length - 1] || 1;
  const plotW = Math.max(40, width - left - right); const plotH = height - top - bottom;
  const sx = (i: number) => left + (pts.length === 1 ? plotW / 2 : (i / (pts.length - 1)) * plotW);
  const sy = (v: number) => top + plotH - (Math.max(0, v) / axisMax) * plotH;
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(i)},${sy(p.value)}`).join(' ');
  const every = Math.max(1, Math.ceil(pts.length / Math.max(1, Math.floor(plotW / 70))));
  const nearest = (clientX: number, el: SVGSVGElement) => {
    const x = clientX - el.getBoundingClientRect().left;
    let best = 0; for (let i = 1; i < pts.length; i++) if (Math.abs(sx(i) - x) < Math.abs(sx(best) - x)) best = i;
    return best;
  };
  return (
    <div ref={ref} className="relative w-full">
      <svg width={width} height={height} role="img" aria-label={label}
        onMouseMove={(e) => setHover(nearest(e.clientX, e.currentTarget))} onMouseLeave={() => setHover(null)}
        onClick={() => { const g = hover !== null ? pts[hover]?.group : undefined; if (g && onSelect) onSelect(g); }}>
        {ticks.map((t) => <g key={t}><line x1={left} x2={width - right} y1={sy(t)} y2={sy(t)} stroke={C.grid} strokeWidth={1} />
          <text x={left - 6} y={sy(t) + 3} fontSize={10} textAnchor="end" fill={C.muted}>{formatAxis(t, data.yType)}</text></g>)}
        {pts.map((p, i) => (i % every === 0 ? <text key={i} x={sx(i)} y={height - 6} fontSize={10} textAnchor="middle" fill={C.muted}>{p.label}</text> : null))}
        {hover !== null && <line x1={sx(hover)} x2={sx(hover)} y1={top} y2={top + plotH} stroke={C.muted} strokeWidth={1} strokeDasharray="3 3" />}
        <path d={d} fill="none" stroke={C.mark} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {pts.map((p, i) => <circle key={i} data-testid="chart-point" cx={sx(i)} cy={sy(p.value)} r={hover === i ? 5 : 4} fill={C.mark} stroke={C.surface} strokeWidth={2} />)}
      </svg>
      {hover !== null && pts[hover] && <Tooltip x={sx(hover)} y={sy(pts[hover]!.value)} title={pts[hover]!.label} value={formatCell(pts[hover]!.value, data.yType)} />}
    </div>
  );
}

/** Part-to-whole as share bars (desc, small shares folded into "Other"), each labelled with its % and value. */
function ShareBars({ data, onSelect, label }: Props) {
  const items = shares(data.points);
  return (
    <ul className="space-y-1.5" aria-label={label}>
      {items.map((s, i) => {
        const clickable = !!(onSelect && s.group);
        return (
          <li key={`${s.label}-${i}`} data-testid="chart-share">
            <button type="button" className="w-full text-left disabled:cursor-default" disabled={!clickable} onClick={() => clickable && onSelect!(s.group!)}
              title={`${s.label}: ${formatCell(s.value, data.yType)} (${s.pct}%)`}>
              <div className="flex justify-between gap-2 text-xs"><span className="truncate">{s.label}</span><span className="tabular-nums text-muted">{s.pct}% · {formatCell(s.value, data.yType)}</span></div>
              <div className="mt-0.5 h-2 w-full rounded bg-surface-alt"><div className="h-2 rounded" style={{ width: `${Math.max(1, s.pct)}%`, background: C.mark }} /></div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
