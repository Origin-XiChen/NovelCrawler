export function openExternal(url: string): void {
  if (window.desktop) {
    void window.desktop.openExternal(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

export function classicUrl(): string {
  const base = window.desktop?.backendUrl ?? 'http://127.0.0.1:8765';
  return `${base.replace(/\/$/, '')}/`;
}

export function openClassicUi(): void {
  openExternal(classicUrl());
}
