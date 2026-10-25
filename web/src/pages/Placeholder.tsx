import type { LucideIcon } from 'lucide-react';
import { Home } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

interface PlaceholderProps {
  title: string;
  description: string;
  icon: LucideIcon;
}

export function Placeholder({ title, description, icon: Icon }: PlaceholderProps) {
  const navigate = useNavigate();

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
          <div className="empty__title">没有找到这个页面</div>
          <div className="empty__desc">可以返回概览，或使用顶部搜索继续查找。</div>
          <button
            type="button"
            className="btn"
            style={{ marginTop: 14 }}
            onClick={() => navigate('/')}
          >
            <Home size={15} />
            返回概览
          </button>
        </div>
      </div>
    </div>
  );
}
