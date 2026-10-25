export function openExternal(url: string): void {
  if (window.desktop) {
    void window.desktop.openExternal(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}
