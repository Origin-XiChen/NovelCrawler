import { Download, ExternalLink, FolderOpen, Github, RefreshCw, Sparkles } from 'lucide-react';
import { useTheme, type ThemeMode } from '../lib/theme';
import { useUpdate } from '../lib/updater';
import { openClassicUi, openExternal } from '../lib/desktop';
import { useToast } from '../lib/toast';

const THEMES: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];

export function SettingsPage() {
  const { mode, setMode } = useTheme();
  const { state, appVersion, bridgeAvailable, check, download, install } = useUpdate();
  const { toast } = useToast();

  const openDataDir = async () => {
    if (!window.desktop) {
      toast('仅桌面版支持打开数据目录', 'error');
      return;
    }
    await window.desktop.openDir();
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">设置</h1>
          <p className="page-desc">外观、更新与数据位置。</p>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-row">
          <div>
            <div className="settings-row__title">外观</div>
            <div className="settings-row__desc">深色模式会同步应用到所有新界面。</div>
          </div>
          <div className="segmented" role="group" aria-label="主题">
            {THEMES.map((item) => (
              <button
                key={item.value}
                type="button"
                className={mode === item.value ? 'is-on' : ''}
                onClick={() => setMode(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="settings-row">
          <div>
            <div className="settings-row__title">版本更新</div>
            <div className="settings-row__desc">
              当前 v{appVersion}
              {!bridgeAvailable
                ? ' · 浏览器模式不支持自动更新'
                : state.phase === 'available'
                  ? ` · 发现 v${state.version}`
                  : state.phase === 'downloaded'
                    ? ` · v${state.version} 已下载，等待安装`
                    : state.phase === 'error'
                      ? ` · ${state.message ?? '检查失败'}`
                      : ' · GitHub Releases 通道'}
            </div>
            {state.phase === 'downloading' ? (
              <div className="update-card__bar" style={{ marginTop: 10, maxWidth: 260 }}>
                <i style={{ width: `${state.percent ?? 0}%` }} />
              </div>
            ) : null}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {state.phase === 'available' ? (
              <button type="button" className="btn" onClick={download}>
                <Download size={15} />
                下载更新
              </button>
            ) : state.phase === 'downloaded' ? (
              <button type="button" className="btn" onClick={install}>
                <Download size={15} />
                重启安装
              </button>
            ) : (
              <button
                type="button"
                className="btn btn--ghost"
                onClick={check}
                disabled={!bridgeAvailable || state.phase === 'checking'}
              >
                <RefreshCw size={15} />
                {state.phase === 'checking' ? '检查中…' : '检查更新'}
              </button>
            )}
          </div>
        </div>

        <div className="settings-row">
          <div>
            <div className="settings-row__title">数据目录</div>
            <div className="settings-row__desc">书架、配置、下载文件都保存在这里。</div>
          </div>
          <button type="button" className="btn btn--ghost" onClick={() => void openDataDir()}>
            <FolderOpen size={15} />
            打开目录
          </button>
        </div>

        <div className="settings-row">
          <div>
            <div className="settings-row__title">经典界面</div>
            <div className="settings-row__desc">
              书源管理、OPDS、手机连接等高级功能可暂时在经典界面使用，数据与新界面互通。
            </div>
          </div>
          <button type="button" className="btn btn--ghost" onClick={openClassicUi}>
            <ExternalLink size={15} />
            打开经典界面
          </button>
        </div>

        <div className="settings-row">
          <div>
            <div className="settings-row__title">关于</div>
            <div className="settings-row__desc">
              小说管家 · 多源小说 / 漫画聚合下载器 · GPL-3.0
            </div>
          </div>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => openExternal('https://github.com/Origin-XiChen/NovelCrawler')}
          >
            <Github size={15} />
            GitHub
          </button>
        </div>

        <div className="update-card" style={{ marginTop: 4 }}>
          <div className="update-card__title">
            <Sparkles size={14} />
            新界面已覆盖主要使用流程
          </div>
          <div className="update-card__meta">
            概览、搜索、书架、任务、文件、漫画与阅读器均已迁移；书源管理、OPDS
            与手机连接等高级功能保留在经典界面。
          </div>
        </div>
      </div>
    </div>
  );
}
