self.addEventListener('push', function(event) {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    try { payload = { title: 'Incoming', body: String(event.data && event.data.text ? event.data.text() : 'Incoming notification') }; } catch (err) { payload = { title: 'Incoming', body: 'Incoming notification' }; }
  }
  const title = payload.title || 'Incoming call';
  const options = {
    body: payload.body || '',
    icon: payload.icon || '/favicon-192.png',
    badge: payload.badge || '/favicon-192.png',
    data: payload.data || {},
    requireInteraction: true,
    actions: [
      { action: 'accept', title: 'Accept' },
      { action: 'decline', title: 'Decline' }
    ]
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const action = event.action;
  const data = event.notification.data || {};
  const url = data.url || '/';
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
    for (let i = 0; i < clientList.length; i++) {
      const client = clientList[i];
      if (client.url && client.url.includes(location.origin) && 'focus' in client) {
        client.postMessage({ type: 'notification_action', action: action, data: data });
        return client.focus();
      }
    }
    return clients.openWindow(url).then(function(windowClient) {
      if (windowClient) windowClient.postMessage({ type: 'notification_action', action: action, data: data });
    });
  }));
});

self.addEventListener('pushsubscriptionchange', function(event) {
  event.waitUntil((async function() {
    try {
      const registration = await self.registration;
      const response = await fetch('/vapidPublicKey');
      const json = await response.json();
      const vapidPublicKey = json && json.publicKey ? json.publicKey : null;
      if (!vapidPublicKey) return;
      const converted = urlBase64ToUint8Array(vapidPublicKey);
      const newSub = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: converted });
      await fetch('/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: newSub }) });
    } catch (e) {}
  })());
});

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
