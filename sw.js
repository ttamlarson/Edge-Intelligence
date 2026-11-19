const CACHE_PREFIX = "edge-shell-v";
const CACHE_NAME = `${CACHE_PREFIX}13`;
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./domain.js",
  "./autonomous-engine.js",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(SHELL);
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", event => {
  if (event.data?.type !== "SKIP_WAITING") return;
  const task = (async () => {
    await self.skipWaiting();
    event.ports?.[0]?.postMessage({ type: "SKIP_WAITING_ACCEPTED" });
  })();
  event.waitUntil(task);
});

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.includes("/api/")) return;
  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response.ok && response.type === "basic") {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    } catch (error) {
      if (request.mode === "navigate") return (await caches.match("./index.html")) || Response.error();
      throw error;
    }
  })());
});
