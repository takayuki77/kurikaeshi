/* くりかえし帳 service worker
   役割1: アプリ本体を端末に置いて、電波が悪くても開けるようにする
   役割2: プッシュ通知を受け取って表示する（第2段階でサーバーとつなぐ） */
const CACHE = 'kurikaeshi-v1';
const FILES = ['./', 'index.html', 'logic.js', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // まずネットワークから取り、失敗したら手元の控えを使う（更新が反映されやすい）
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(e.request))
  );
});

/* プッシュ通知（第2段階で有効になる） */
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) {}
  const title = data.title || 'くりかえし帳';
  const body = data.body || '今日のタスクがあります';
  e.waitUntil((async () => {
    await self.registration.showNotification(title, {
      body,
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      data: { url: './' },
    });
    if (typeof data.badge === 'number' && 'setAppBadge' in self.navigator) {
      try { await self.navigator.setAppBadge(data.badge); } catch (err) {}
    }
  })());
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      return self.clients.openWindow('./');
    })
  );
});
