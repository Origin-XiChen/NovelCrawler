/**
 * 记住列表页的滚动位置：从书籍详情返回、或在书库/书架页签之间切换时，
 * 不要把用户甩回顶部。数据加载完成（ready）后再恢复，避免列表没渲染时失效。
 */
import { useEffect, useRef } from 'react';

const PREFIX = 'nc.scroll.';

export function useScrollMemory(key: string, ready = true): void {
  const restoredKey = useRef('');

  useEffect(() => {
    if (!ready || restoredKey.current === key) return;
    restoredKey.current = key;
    let top = 0;
    try {
      top = Number(sessionStorage.getItem(PREFIX + key)) || 0;
    } catch {
      return;
    }
    if (top <= 0) {
      // 第一次进这个页签/筛选时从顶部开始，别继承上一个列表的滚动位置
      window.scrollTo({ top: 0, behavior: 'auto' });
      return;
    }
    let first = 0;
    let second = 0;
    first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => window.scrollTo({ top, behavior: 'auto' }));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [key, ready]);

  useEffect(() => {
    if (!ready) return;
    let raf = 0;
    const save = () => {
      try {
        sessionStorage.setItem(PREFIX + key, String(window.scrollY));
      } catch {
        // 隐私模式忽略
      }
    };
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        save();
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
      save();
    };
  }, [key, ready]);
}
