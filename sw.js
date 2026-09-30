// Офлайн-кэш приложения. При изменении файлов увеличьте номер версии.
const CACHE = 'my-words-v1';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest',
  'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Сначала сеть (чтобы сразу получать обновления и новые слова), при отсутствии связи — кэш.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          const key = req.url.split('?')[0];
          caches.open(CACHE).then(c => c.put(key, copy));
        }
        return res;
      })
      .catch(() => caches.match(req.url.split('?')[0]).then(r => r || caches.match('index.html')))
  );
});
