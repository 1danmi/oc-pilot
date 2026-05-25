interface Props {
  label: string;
  value: number | string;
  sub?: string;
}

export default function StatCard({ label, value, sub }: Props) {
  return (
    <div className="panel stat-card">
      <div className="label">{label}</div>
      <div className="value">{typeof value === 'number' ? value.toLocaleString() : value}</div>
      {sub ? <div className="sub">{sub}</div> : null}
    </div>
  );
}
