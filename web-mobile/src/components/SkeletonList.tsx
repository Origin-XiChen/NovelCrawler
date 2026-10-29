interface Props {
  rows?: number;
  cover?: boolean;
  compact?: boolean;
}

/** 列表加载占位：先把版式撑住，比整块转圈少一次跳动。 */
export default function SkeletonList({ rows = 5, cover = true, compact = false }: Props) {
  return (
    <div
      className={`skeleton-list${compact ? ' skeleton-list--compact' : ''}`}
      role="status"
      aria-label="正在加载"
    >
      {Array.from({ length: rows }, (_, index) => (
        <div className="skeleton-row" key={index}>
          {cover && <div className="skeleton skeleton-row__cover" />}
          <div className="skeleton-row__body">
            <div
              className="skeleton skeleton-line"
              style={{ width: `${72 - (index % 3) * 7}%` }}
            />
            <div className="skeleton skeleton-line skeleton-line--short" />
            {!compact && <div className="skeleton skeleton-line skeleton-line--tiny" />}
          </div>
        </div>
      ))}
    </div>
  );
}
