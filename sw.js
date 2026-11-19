const CACHE_PREFIX = "edge-shell-v";
const CACHE_NAME = `${CACHE_PREFIX}18`;
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./domain.js",
  "./autonomous-engine.js",
  "./coinspot-strategy.js",
  "./adaptive-regime-strategy.js",
  "./regime-adaptive-breakout.js",
  "./crypto-csv.js",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png"
];
const SHELL_PATHS = new Set(SHELL.map(path => new URL(path, self.location.origin).pathname));

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
    const cache = await caches.open(CACHE_NAME);
    // Always revalidate the app shell so installed PWAs cannot remain pinned to
    // an old app.js bundle after a deployment. Keep the last good copy offline.
    if (SHELL_PATHS.has(url.pathname)) {
      try {
        const response = await fetch(request, { cache: "no-cache" });
        if (response.ok && response.type === "basic") await cache.put(request, response.clone());
        return response;
      } catch (error) {
        const cached = await cache.match(request);
        if (cached) return cached;
        if (request.mode === "navigate") return (await cache.match("./index.html")) || Response.error();
        throw error;
      }
    }
    const cached = await cache.match(request);
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response.ok && response.type === "basic") await cache.put(request, response.clone());
      return response;
    } catch (error) {
      if (request.mode === "navigate") return (await cache.match("./index.html")) || Response.error();
      throw error;
    }
  })());
});
