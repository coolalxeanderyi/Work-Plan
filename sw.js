// 離線快取：有網路時一律抓最新版（一打開就是新版），沒網路或太慢時才用快取
const CACHE = 'workplan-v7';
const ASSETS = ['./', 'index.html', 'style.css', 'app.js', 'firebase-config.js', 'manifest.json', 'icons/icon.svg', 'icons/icon-192.png'];
const TIMEOUT_MS = 4000;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(networkFirst(e.request));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  // no-cache：跳過瀏覽器的 HTTP 快取，向 GitHub 確認是不是最新版
  const network = fetch(req.url, { cache: 'no-cache' }).then(res => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  });
  try {
    return await Promise.race([network, new Promise((_, reject) => setTimeout(reject, TIMEOUT_MS))]);
  } catch {
    return (await cache.match(req)) || network;
  }
}
