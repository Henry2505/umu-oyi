(async function(){
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

  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    const vapidResp = await fetch('/vapidPublicKey');
    const vapidJson = await vapidResp.json();
    const publicKey = vapidJson && vapidJson.publicKey ? vapidJson.publicKey : null;
    if (!publicKey) return;
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;
    const subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
    const userId = (window.currentUser && (window.currentUser.id || window.currentUser.user_id)) || (localStorage.getItem('currentUser') ? (JSON.parse(localStorage.getItem('currentUser') || '{}').id || null) : null);
    await fetch('/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: userId, subscription: subscription }) });
    navigator.serviceWorker.addEventListener('message', function(ev){
      try {
        const d = ev.data || {};
        if (d && d.type === 'notification_action') {
          if (d.action === 'accept') window.focus && window.focus();
        }
      } catch (e) {}
    });
  } catch (e) {}
})();
