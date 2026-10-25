import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { BookOpen, Copy, Download, Minus, Moon, Search, Square, Sun, X } from 'lucide-react';
import { useTheme } from '../lib/theme';
import { useUpdate } from '../lib/updater';

export function TitleBar() {
  const navigate = useNavigate();
  const { resolved, toggle } = useTheme();
  const { state } = useUpdate();
  const [query, setQuery] = useState('');
  const [maximized, setMaximized] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const bridge = window.desktop;

  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    void bridge.window.isMaximized().then((value) => {
      if (alive) setMaximized(value);
    });
    const off = bridge.window.onMaximizedChange(setMaximized);
    return () => {
      alive = false;
      off();
    };
  }, [bridge]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const keyword = query.trim();
    if (!keyword) return;
    navigate(`/search?q=${encodeURIComponent(keyword)}`);
    setQuery('');
  };

  const hasUpdate = state.phase === 'available' || state.phase === 'downloaded';

  return (
    <header className="titlebar">
      <div className="titlebar__brand">
        <span className="brand-mark" aria-hidden="true">
          <BookOpen size={15} strokeWidth={2.2} />
        </span>
        <span>
          <span className="titlebar__name">小说管家</span>
          <span className="titlebar__sub">NovelCrawler</span>
        </span>
      </div>

      <form className="titlebar__search" onSubmit={submit} role="search">
        <label className="searchbox">
          <Search size={15} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索书名、作者…"
            aria-label="搜索书名或作者"
          />
          <kbd>Ctrl K</kbd>
        </label>
      </form>

      <div className="titlebar__spacer" />

      <div className="titlebar__actions">
        {hasUpdate && (
          <button
            type="button"
            className="tb-btn is-active"
            title="发现新版本"
            onClick={() => navigate('/settings')}
          >
            <Download size={16} />
          </button>
        )}
        <button
          type="button"
          className="tb-btn"
          title={resolved === 'dark' ? '切换到浅色' : '切换到深色'}
          onClick={toggle}
        >
          {resolved === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      </div>

      {bridge && (
        <div className="win-controls">
          <button
            type="button"
            className="win-btn"
            title="最小化"
            onClick={() => bridge.window.minimize()}
          >
            <Minus size={16} />
          </button>
          <button
            type="button"
            className="win-btn"
            title={maximized ? '还原' : '最大化'}
            onClick={() => bridge.window.toggleMaximize()}
          >
            {maximized ? <Copy size={13} /> : <Square size={13} />}
          </button>
          <button
            type="button"
            className="win-btn win-btn--close"
            title="关闭"
            onClick={() => bridge.window.close()}
          >
            <X size={16} />
          </button>
        </div>
      )}
    </header>
  );
}
