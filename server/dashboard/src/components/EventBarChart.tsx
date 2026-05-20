import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { Stats } from '../api';

// ── Category metadata ─────────────────────────────────────────────────────────
// Defines display order, label, and bar colour for each event-name prefix.
// Unknown prefixes fall through to a generic grey entry.

interface CategoryMeta {
  title: string;
  color: string;
  order: number;
}

const CATEGORY_META: Record<string, CategoryMeta> = {
  click:     { title: 'Click events',  color: '#58a6ff', order: 1 },
  settings:  { title: 'Settings',      color: '#d2a8ff', order: 2 },
  popup:     { title: 'Popup',         color: '#79c0ff', order: 3 },
  autologin: { title: 'Auto-login',    color: '#ffa657', order: 4 },
  copylogin: { title: 'Copy login',    color: '#ff7b72', order: 5 },
  inject:    { title: 'Injections',    color: '#3fb950', order: 6 },
  lifecycle: { title: 'Lifecycle',     color: '#8b949e', order: 7 },
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface EventRow {
  /** Full event name, e.g. "click.favourites.add" */
  name: string;
  /** Suffix after the first dot, used as the Y-axis label */
  label: string;
  total: number;
  avg: number;
}

interface Category {
  prefix: string;
  title: string;
  color: string;
  order: number;
  events: EventRow[];
}

// ── Grouping logic ────────────────────────────────────────────────────────────

function groupByPrefix(
  perEventTotal: Record<string, number>,
  perEventAvg: Record<string, number>,
): Category[] {
  const groups = new Map<string, EventRow[]>();

  for (const [name, total] of Object.entries(perEventTotal)) {
    const dot = name.indexOf('.');
    const prefix = dot === -1 ? name : name.slice(0, dot);
    const label  = dot === -1 ? name : name.slice(dot + 1);

    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix)!.push({ name, label, total, avg: perEventAvg[name] ?? 0 });
  }

  const result: Category[] = [];
  for (const [prefix, events] of groups) {
    const meta = CATEGORY_META[prefix] ?? { title: prefix, color: '#8b949e', order: 99 };
    result.push({
      prefix,
      title:  meta.title,
      color:  meta.color,
      order:  meta.order,
      events: [...events].sort((a, b) => b.total - a.total),
    });
  }

  return result.sort((a, b) => a.order - b.order);
}

// ── Sub-component: one chart per category ─────────────────────────────────────

interface CategoryChartProps {
  category: Category;
}

function CategoryChart({ category }: CategoryChartProps) {
  // Enough vertical space for each bar + axis labels; minimum so single-event
  // categories don't look squashed.
  const chartHeight = Math.max(56, category.events.length * 30 + 20);
  const categoryTotal = category.events.reduce((s, e) => s + e.total, 0);

  return (
    <div style={{ marginBottom: 28 }}>
      {/* Category header ─────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        marginBottom: 8,
        borderBottom: '1px solid var(--panel-border)',
        paddingBottom: 6,
      }}>
        <span style={{
          display: 'inline-block',
          width: 10,
          height: 10,
          borderRadius: 2,
          background: category.color,
          flexShrink: 0,
        }} />
        <span style={{
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--text)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}>
          {category.title}
        </span>
        <span style={{
          marginLeft: 'auto',
          fontSize: 12,
          color: 'var(--text-dim)',
          fontVariantNumeric: 'tabular-nums',
        }}>
          {categoryTotal.toLocaleString()} total
        </span>
      </div>

      {/* Bar chart ───────────────────────────────────────────────────────── */}
      <ResponsiveContainer width="100%" height={chartHeight}>
        <BarChart
          data={category.events}
          layout="vertical"
          margin={{ top: 0, right: 56, bottom: 0, left: 8 }}
        >
          <CartesianGrid strokeDasharray="3 3" horizontal={false} />
          <XAxis type="number" tick={{ fontSize: 11 }} />
          <YAxis
            type="category"
            dataKey="label"
            width={210}
            interval={0}
            tick={{ fontSize: 12 }}
          />
          <Tooltip
            formatter={(value: number, key: string) => {
              if (key === 'avg') return [value.toFixed(2), 'avg / user'];
              return [value.toLocaleString(), 'total'];
            }}
            // Show the full event name (prefix.label) in the tooltip header.
            labelFormatter={(label: string) => `${category.prefix}.${label}`}
          />
          <Bar dataKey="total" fill={category.color} radius={[0, 3, 3, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

interface Props {
  stats: Stats;
}

export default function EventBarChart({ stats }: Props) {
  const categories = useMemo(
    () => groupByPrefix(stats.per_event_total, stats.per_event_avg_per_user),
    [stats],
  );

  if (!categories.length) {
    return (
      <div className="panel">
        <h2>Events by type</h2>
        <p style={{ color: 'var(--text-dim)' }}>No events recorded yet.</p>
      </div>
    );
  }

  return (
    <div className="panel">
      <h2>Events by type</h2>
      {categories.map((cat) => (
        <CategoryChart key={cat.prefix} category={cat} />
      ))}
    </div>
  );
}
