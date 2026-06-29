/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />

// Web Push service worker. SvelteKit builds and auto-registers this file.
// It wakes on push (even with the tab closed), shows an OS notification, and
// focuses/deep-links the app on click. Payload shape matches the relay's
// PushPayload (title, body, url, tag).

const sw = self as unknown as ServiceWorkerGlobalScope;

interface PushPayload {
  title?: string;
  body?: string;
  url?: string;
  tag?: string;
}

sw.addEventListener("push", (event: PushEvent) => {
  if (!event.data) return;
  let payload: PushPayload;
  try {
    payload = event.data.json() as PushPayload;
  } catch {
    payload = { title: "Cyborg7", body: event.data.text() };
  }
  const title = payload.title || "Cyborg7";
  event.waitUntil(
    sw.registration.showNotification(title, {
      body: payload.body || "",
      icon: "/favicon.png",
      badge: "/favicon.png",
      tag: payload.tag || undefined,
      // Re-buzz on a repeat from the same conversation instead of sitting silent.
      renotify: Boolean(payload.tag),
      data: { url: payload.url || "/" },
    }),
  );
});

sw.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();
  const url = (event.notification.data as { url?: string } | null)?.url || "/";
  event.waitUntil(
    (async () => {
      const all = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of all) {
        try {
          if (client.url && new URL(client.url).origin === sw.location.origin) {
            await client.focus();
            if ("navigate" in client) await client.navigate(url);
            return;
          }
        } catch {
          // invalid URL or focus/navigate failed — keep looking
        }
      }
      if (sw.clients.openWindow) await sw.clients.openWindow(url);
    })(),
  );
});
