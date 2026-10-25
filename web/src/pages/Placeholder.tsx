import type { LucideIcon } from 'lucide-react';
import { ExternalLink } from 'lucide-react';
import { openClassicUi } from '../lib/desktop';

interface PlaceholderProps {
  title: string;
  description: string;
  icon: LucideIcon;
  features: string[];
}

export function Placeholder({ title, description, icon: Icon, features }: PlaceholderProps) {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{title}</h1>
          <p className="page-desc">{description}</p>
        </div>
      </div>

      <div className="card">
        <div className="empty">
          <div className="empty__icon">
            <Icon size={22} />
          </div>
          <div className="empty__title">这个页面正在迁移到新界面</div>
          <div className="empty__desc">
            功能与数据都不受影响，迁移完成前可以继续使用经典界面。
          </div>
          <div className="source-chips" style={{ justifyContent: 'center', marginTop: 8 }}>
            {features.map((feature) => (
              <span key={feature} className="source-chip">
                {feature}
              </span>
            ))}
          </div>
          <button
            type="button"
            className="btn"
            style={{ marginTop: 14 }}
            onClick={openClassicUi}
          >
            <ExternalLink size={15} />
            打开经典界面
          </button>
        </div>
      </div>
    </div>
  );
}
