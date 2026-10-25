/* 旧版经典界面注册的 Service Worker 已退役:新界面不依赖离线缓存。
   保留此文件用于让存量客户端更新后自动注销并清理旧缓存。 */
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
    await self.registration.unregister();
  })());
});
