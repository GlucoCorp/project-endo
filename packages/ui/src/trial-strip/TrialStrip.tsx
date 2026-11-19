import { useId } from 'react';
import { describeWeek, type StripModel } from './model.ts';

/**
 * The Trial Strip (spec 21.6): weekly columns by four ruled lanes, as SVG, with an equivalent
 * table for screen readers (visually hidden, linked by aria-describedby). Colour never carries
 * meaning alone: marks differ in shape and every value is in the table.
 */
const LANES = ['Benefit', 'Side effects', 'Taken', 'Barriers'] as const;
const COL = 28;
const LANE = 30;
const LEFT = 84;

export function TrialStrip(props: { readonly model: StripModel; readonly title: string }) {
  const tableId = useId();
  const { weeks } = props.model;
  const width = LEFT + weeks.length * COL + 4;
  const height = LANES.length * LANE + 22;
  return (
    <figure style={{ margin: 0 }}>
      <svg
        role="img"
        aria-label={props.title}
        aria-describedby={tableId}
        viewBox={`0 0 ${String(width)} ${String(height)}`}
        style={{ width: '100%', maxWidth: `${String(width * 1.6)}px`, height: 'auto' }}
      >
        <defs>
          <pattern
            id={`${tableId}-hatch`}
            width="6"
            height="6"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--rule, #bbb)" strokeWidth="2" />
          </pattern>
        </defs>
        {LANES.map((name, i) => (
          <g key={name}>
            <text x="0" y={i * LANE + 19} fontSize="10" fill="var(--ink-muted, #555)">
              {name}
            </text>
            <line
              x1={LEFT}
              x2={width}
              y1={(i + 1) * LANE}
              y2={(i + 1) * LANE}
              stroke="var(--rule, #ccc)"
            />
          </g>
        ))}
        {weeks.map((w, idx) => {
          const x = LEFT + idx * COL;
          const label = (
            <text
              x={x + COL / 2}
              y={height - 4}
              fontSize="9"
              textAnchor="middle"
              fill="var(--ink-muted, #555)"
            >
              {w.week}
            </text>
          );
          const review = w.review ? (
            <line
              x1={x + COL - 1}
              x2={x + COL - 1}
              y1={0}
              y2={LANES.length * LANE}
              stroke="var(--ink, #222)"
              strokeWidth="2"
            />
          ) : null;
          if (!w.entry)
            return (
              <g key={w.week}>
                <rect
                  x={x + 2}
                  y={2}
                  width={COL - 4}
                  height={LANES.length * LANE - 4}
                  fill={`url(#${tableId}-hatch)`}
                />
                {label}
                {review}
              </g>
            );
          // Benefit: a bar for relief against the baseline (taller is less pain), a rule at baseline.
          const mid = LANE / 2;
          const bar = w.change === null ? 0 : Math.max(-10, Math.min(10, w.change)) * (mid / 10);
          const goal =
            w.goal === 'met' ? (
              <circle cx={x + COL / 2} cy={LANE - 4} r="3" fill="var(--lane-benefit, #2E6B4A)" />
            ) : w.goal === 'partly' ? (
              <path
                d={`M ${String(x + COL / 2 - 3)} ${String(LANE - 4)} a 3 3 0 0 0 6 0 z`}
                fill="var(--lane-benefit, #2E6B4A)"
              />
            ) : w.goal === 'not_met' ? (
              <circle
                cx={x + COL / 2}
                cy={LANE - 4}
                r="3"
                fill="none"
                stroke="var(--lane-benefit, #2E6B4A)"
              />
            ) : null;
          const ticks = Array.from({ length: 7 }, (_, d) => (
            <rect
              key={d}
              x={x + 3 + d * 3.2}
              y={2 * LANE + 8}
              width="2.4"
              height="14"
              fill={w.taken !== null && d < w.taken ? 'var(--lane-taken, #34508F)' : 'none'}
              stroke="var(--lane-taken, #34508F)"
              strokeWidth="0.6"
            />
          ));
          return (
            <g key={w.week}>
              <line x1={x + 4} x2={x + COL - 4} y1={mid} y2={mid} stroke="var(--rule, #ccc)" />
              {bar !== 0 && (
                <rect
                  x={x + COL / 2 - 4}
                  y={bar > 0 ? mid - bar : mid}
                  width="8"
                  height={Math.abs(bar)}
                  fill="var(--lane-benefit, #2E6B4A)"
                />
              )}
              {goal}
              {w.sideEffects !== null && w.sideEffects > 0 && (
                <line
                  x1={x + 6}
                  x2={x + COL - 6}
                  y1={LANE + LANE / 2}
                  y2={LANE + LANE / 2}
                  stroke="var(--lane-side-effects, #8A5A08)"
                  strokeWidth={w.sideEffects * 2.5}
                />
              )}
              {ticks}
              {w.barriers.length > 0 && (
                <text
                  x={x + COL / 2}
                  y={3 * LANE + 19}
                  fontSize="10"
                  textAnchor="middle"
                  fill="var(--lane-barriers, #6A4F86)"
                >
                  {'◆'.repeat(Math.min(3, w.barriers.length))}
                </text>
              )}
              {label}
              {review}
            </g>
          );
        })}
      </svg>
      <table
        id={tableId}
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
          whiteSpace: 'nowrap',
        }}
      >
        <caption>{props.title}</caption>
        <thead>
          <tr>
            <th scope="col">Week</th>
            {LANES.map((l) => (
              <th key={l} scope="col">
                {l}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((w) => {
            const [week, ...cells] = describeWeek(w);
            return (
              <tr key={w.week}>
                <th scope="row">{week}</th>
                {cells.map((c, i) => (
                  <td key={i}>{c}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </figure>
  );
}
