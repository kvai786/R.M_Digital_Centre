"use strict";

const CACHE_NAME = "rm-digital-centre-v24";
const APP_SHELL = [
    "./",
    "./index.html",
    "./login.html",
    "./register.html",
    "./admin.html",
    "./retailer.html",
    "./styles.css",
    "./app.js",
    "./home-services.js",
    "./assistant.css",
    "./public-assistant.js",
    "./portal-assistant.js",
    "./rm-voice.js",
    "./track.html",
    "./track.js",
    "./commission.html",
    "./commission.js",
    "./compliance.html",
    "./compliance.js",
    "./terms.html",
    "./privacy.html",
    "./refund.html",
    "./rm-theme.css",
    "./rm-particles.js",
    "./manifest.json",
    "./icon.svg",
    "./icon-192.png",
    "./icon-512.png"
];

self.addEventListener("install", function (event) {
    event.waitUntil(caches.open(CACHE_NAME).then(function (cache) {
        return cache.addAll(APP_SHELL);
    }));
    self.skipWaiting();
});

self.addEventListener("activate", function (event) {
    event.waitUntil(caches.keys().then(function (keys) {
        return Promise.all(keys.filter(function (key) {
            return key !== CACHE_NAME;
        }).map(function (key) {
            return caches.delete(key);
        }));
    }));
    self.clients.claim();
});

self.addEventListener("fetch", function (event) {
    if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) {
        return;
    }
    const requestPath = new URL(event.request.url).pathname;
    if (requestPath.startsWith("/api/") || requestPath.startsWith("/supreme-owner")) {
        return;
    }
    if (event.request.destination === "video" || event.request.headers.has("range")) {
        return;
    }
    if (event.request.mode === "navigate") {
        event.respondWith(fetch(event.request).then(function (response) {
            if (response.ok) {
                const copy = response.clone();
                caches.open(CACHE_NAME).then(function (cache) {
                    return cache.put(event.request, copy);
                });
            }
            return response;
        }).catch(function () {
            return caches.match(event.request).then(function (cached) {
                return cached || caches.match("./index.html");
            });
        }));
        return;
    }
    event.respondWith(fetch(event.request).then(function (response) {
        if (!response.ok) {
            return response;
        }
        const copy = response.clone();
        return caches.open(CACHE_NAME).then(function (cache) {
            return cache.put(event.request, copy).then(function () {
                return response;
            });
        });
    }).catch(function (error) {
        return caches.match(event.request).then(function (cached) {
            if (cached) {
                return cached;
            }
            throw error;
        });
    }));
});
