export function loadedBuildId(): string {
  const match = /\/assets\/[^/]+-([A-Za-z0-9_-]{6,})\.js(?:[?#]|$)/.exec(import.meta.url);
  return match?.[1] || '';
}
