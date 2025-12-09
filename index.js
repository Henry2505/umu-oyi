'use strict';
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bodyParser = require('body-parser');
const helmet = require('helmet');

const REDIS_URL = process.env.REDIS_URL || '';
const WEBSOCKET_SECRET = process.env.WEBSOCKET_SECRET || '';
const PORT = process.env.PORT || 3000;
const REALTIME_WS_PATH = process.env.REALTIME_WS_PATH || '/realtime-ws';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '') || '';

let redis = null;
let redisPub = null;
let redisSub = null;
const USE_REDIS = !!REDIS_URL;

if (USE_REDIS) {
  try {
    const IORedis = require('ioredis');
    redisPub = new IORedis(REDIS_URL);
    redisSub = new IORedis(REDIS_URL);
    redis = new IORedis(REDIS_URL);
    // subscribe in background; errors are non-fatal
    redisSub.subscribe('umuy:realtime').catch(err => {
      console.warn('redisSub.subscribe failed (non-fatal):', String(err));
    });
    console.info('Redis enabled for realtime presence/pubsub');
  } catch (err) {
    console.warn('Failed to init Redis, continuing without it:', String(err));
  }
} else {
  console.info('Redis disabled (REDIS_URL not set)');
}

const app = express();
app.use(helmet());
app.use(bodyParser.json({ limit: '2mb' }));

const userConnections = new Map(); // userId -> Set(ws)
const lastSeenMap = new Map(); // userId -> presence payload

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

function sendWs(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch (e) { /* ignore */ }
}

function broadcastToUser(userId, payload) {
  try {
    if (!userId) return;
    const set = userConnections.get(String(userId));
    if (!set || !set.size) return;
    for (const c of Array.from(set)) {
      try {
        if (c.readyState === WebSocket.OPEN) sendWs(c, payload);
        else {
          try { c.terminate(); } catch (e) {}
          set.delete(c);
        }
      } catch (e) {}
    }
  } catch (e) {}
}

function broadcastToAll(payload) {
  try {
    for (const [uid, set] of userConnections.entries()) {
      for (const c of set) {
        try { if (c.readyState === WebSocket.OPEN) sendWs(c, payload); } catch (e) {}
      }
    }
  } catch (e) {}
}

// update presence immediately in-memory, then persist/publish asynchronously (no await)
async function setPresence(userId, online, extra) {
  try {
    const key = `presence:${userId}`;
    const now = Date.now();
    const payload = { id: String(userId), online: !!online, last_seen: online ? null : now, updated_at: now };
    if (extra && typeof extra === 'object') payload.meta = extra;
    // immediate in-memory update
    lastSeenMap.set(String(userId), payload);
    // publish/write to redis asynchronously (fire-and-forget)
    if (USE_REDIS && redis) {
      try {
        redis.set(key, JSON.stringify(payload), 'EX', 60 * 60 * 24).catch(() => {});
        if (redisPub) redisPub.publish('umuy:realtime', JSON.stringify({ type: 'presence', user: payload, ts: now })).catch(() => {});
      } catch (e) {
        // ignore redis errors; presence already updated in-memory
      }
    } else {
      // broadcast to everyone in-memory
      try { broadcastToAll({ type: 'presence', user: payload, ts: now }); } catch (e) {}
    }
    // debug
    console.info(`presence set (in-memory) for ${userId} online=${!!online}`);
    return payload;
  } catch (e) {
    console.warn('setPresence error', String(e));
    return null;
  }
}

// quick presence read: prefer in-memory, otherwise try redis but with small timeout
async function getPresence(userId) {
  try {
    const key = `presence:${userId}`;
    const local = lastSeenMap.get(String(userId));
    if (local) return local;
    if (USE_REDIS && redis) {
      try {
        const p = redis.get(key);
        const res = await Promise.race([p, new Promise(r => setTimeout(() => r(null), 500))]); // 500ms cap
        if (res) return safeJsonParse(res);
      } catch (e) {
        // ignore
      }
    }
    return lastSeenMap.get(String(userId)) || null;
  } catch (e) {
    return null;
  }
}

app.get('/health', (req, res) => {
  res.json({ ok: true, pid: process.pid, ws_path: REALTIME_WS_PATH });
});

app.post('/emit', async (req, res) => {
  try {
    const provided = (req.headers['x-realtime-secret'] || req.query.secret || '').toString();
    if (!WEBSOCKET_SECRET || provided !== WEBSOCKET_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const payload = req.body || {};
    if (!payload || !payload.type) return res.status(400).json({ error: 'Bad payload' });
    const envelope = { type: payload.type, message: payload.message || null, to: payload.to || null, meta: payload.meta || null, ts: Date.now() };
    if (USE_REDIS && redisPub) {
      try { redisPub.publish('umuy:realtime', JSON.stringify(envelope)).catch(() => {}); } catch (e) {}
    }
    if (envelope.to) broadcastToUser(envelope.to, envelope);
    else broadcastToAll(envelope);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: REALTIME_WS_PATH });

function closeWsWithReason(ws, code = 1008, reason = 'Policy') {
  try { ws.send(JSON.stringify({ type: 'error', reason })); } catch (e) {}
  try { ws.close(code, reason); } catch (e) {}
}

wss.on('connection', (ws, req) => {
  ws._meta = { authenticated: false, userId: null, createdAt: Date.now() };

  try {
    const origin = (req.headers && req.headers.origin) ? req.headers.origin : null;
    console.info('ws connection open - origin:', origin || '<none>');
    // Only enforce allowed origins if env var is set
    if (ALLOWED_ORIGINS.length && origin && !ALLOWED_ORIGINS.includes(origin)) {
      console.warn('origin not allowed:', origin);
      closeWsWithReason(ws, 4003, 'origin_not_allowed');
      return;
    }
  } catch (e) {
    console.warn('origin check error', String(e));
  }

  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
    // optional debug:
    // console.info('pong from client', ws._meta && ws._meta.userId ? ws._meta.userId : '<anon>');
  });

  ws.on('message', async (data) => {
    try {
      let msg = data;
      if (Buffer.isBuffer(msg)) msg = msg.toString();
      const obj = safeJsonParse(msg);
      if (!obj || !obj.type) return;

      if (obj.type === 'auth') {
        const token = (obj.token || '').toString();
        console.info('auth request received (len token):', token ? token.length : 0);
        if (!token) {
          sendWs(ws, { type: 'auth_failed', reason: 'no token' });
          ws.close(4001, 'no token');
          return;
        }
        // try to extract user id from JWT-like token quickly (no verification)
        let userId = token;
        if (token.indexOf('.') > -1) {
          try {
            const parts = token.split('.');
            const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
            userId = payload.sub || payload.user_id || payload.user || payload.id || userId;
          } catch (e) {
            userId = token;
          }
        }
        ws._meta.authenticated = true;
        ws._meta.userId = String(userId);

        // register connection immediately
        const set = userConnections.get(ws._meta.userId) || new Set();
        set.add(ws);
        userConnections.set(ws._meta.userId, set);
        console.info('user registered on WS:', ws._meta.userId, 'connections=', set.size);

        // write presence in-memory and publish asynchronous (do not await)
        try { setPresence(ws._meta.userId, true).catch ? setPresence(ws._meta.userId, true) : setPresence(ws._meta.userId, true); } catch (e) {}

        // send auth_ok immediately (don't wait for redis)
        sendWs(ws, { type: 'auth_ok', userId: ws._meta.userId });

        // send presence snapshot (prefer local fast copy; fallback to short redis query)
        try {
          const presenceLocal = lastSeenMap.get(String(ws._meta.userId));
          if (presenceLocal) {
            sendWs(ws, { type: 'presence_snapshot', user: presenceLocal });
          } else {
            (async () => {
              const pres = await getPresence(ws._meta.userId);
              sendWs(ws, { type: 'presence_snapshot', user: pres || { id: ws._meta.userId, online: true } });
            })().catch(() => {
              sendWs(ws, { type: 'presence_snapshot', user: { id: ws._meta.userId, online: true } });
            });
          }
        } catch (e) {
          sendWs(ws, { type: 'presence_snapshot', user: { id: ws._meta.userId, online: true } });
        }
        return;
      }

      if (!ws._meta || !ws._meta.authenticated) {
        sendWs(ws, { type: 'error', reason: 'not_authenticated' });
        ws.close(4003, 'not_authenticated');
        return;
      }

      // ping/pong handled elsewhere; handle supported message types
      if (obj.type === 'ping') {
        sendWs(ws, { type: 'pong' });
        return;
      }

      if (obj.type === 'typing') {
        const to = obj.to || null;
        const out = { type: 'typing', from: ws._meta.userId, to: to, typing: !!obj.typing, ts: Date.now() };
        if (USE_REDIS && redisPub) {
          try { redisPub.publish('umuy:realtime', JSON.stringify(out)).catch(() => {}); } catch (e) {}
        }
        if (to) broadcastToUser(to, out);
        return;
      }

      if (obj.type === 'delivered' || obj.type === 'message_delivered') {
        const to = obj.to || null;
        const out = { type: 'message_delivered', id: obj.id || obj.messageId || null, from: ws._meta.userId, to: to, ts: Date.now() };
        if (USE_REDIS && redisPub) {
          try { redisPub.publish('umuy:realtime', JSON.stringify(out)).catch(() => {}); } catch (e) {}
        }
        if (to) broadcastToUser(to, out);
        return;
      }

      if (obj.type === 'read' || obj.type === 'message_read') {
        const to = obj.to || null;
        const out = { type: 'message_read', id: obj.id || obj.messageId || null, from: ws._meta.userId, to: to, ts: Date.now() };
        if (USE_REDIS && redisPub) {
          try { redisPub.publish('umuy:realtime', JSON.stringify(out)).catch(() => {}); } catch (e) {}
        }
        if (to) broadcastToUser(to, out);
        return;
      }

      if (obj.type === 'message_played') {
        const to = obj.to || null;
        const out = { type: 'message_played', id: obj.id || null, from: ws._meta.userId, to: to, ts: Date.now() };
        if (USE_REDIS && redisPub) {
          try { redisPub.publish('umuy:realtime', JSON.stringify(out)).catch(() => {}); } catch (e) {}
        }
        if (to) broadcastToUser(to, out);
        return;
      }

      if (obj.type === 'recording') {
        const to = obj.to || null;
        const out = { type: 'recording', from: ws._meta.userId, to: to, status: obj.status || 'start', ts: Date.now() };
        if (USE_REDIS && redisPub) {
          try { redisPub.publish('umuy:realtime', JSON.stringify(out)).catch(() => {}); } catch (e) {}
        }
        if (to) broadcastToUser(to, out);
        return;
      }

      if (obj.type === 'uploading') {
        const to = obj.to || null;
        const out = { type: 'uploading', from: ws._meta.userId, to: to, status: obj.status || 'start', progress: obj.progress || 0, ts: Date.now() };
        if (USE_REDIS && redisPub) {
          try { redisPub.publish('umuy:realtime', JSON.stringify(out)).catch(() => {}); } catch (e) {}
        }
        if (to) broadcastToUser(to, out);
        return;
      }

      if (obj.type === 'location') {
        const lat = obj.lat || null; const lon = obj.lon || null;
        const acc = obj.accuracy || null; const ts = obj.timestamp || Date.now();
        const payload = { id: ws._meta.userId, location: { lat, lon, accuracy: acc, ts }, updated_at: Date.now() };
        const key = `presence:${ws._meta.userId}`;
        try {
          lastSeenMap.set(String(ws._meta.userId), Object.assign({}, lastSeenMap.get(String(ws._meta.userId)) || {}, { id: ws._meta.userId, online: true, location: payload.location, updated_at: Date.now() }));
          if (USE_REDIS && redis) {
            try { redis.set(key, JSON.stringify(lastSeenMap.get(String(ws._meta.userId))), 'EX', 60 * 60 * 24).catch(() => {}); } catch (e) {}
            if (redisPub) redisPub.publish('umuy:realtime', JSON.stringify({ type: 'location', user: payload, to: obj.to || null, ts: Date.now() })).catch(() => {});
          } else {
            try { broadcastToAll({ type: 'location', user: payload, to: obj.to || null, ts: Date.now() }); } catch (e) {}
          }
        } catch (e) {}
        if (obj.to) {
          broadcastToUser(obj.to, { type: 'location', user: payload, to: obj.to, ts: Date.now() });
        } else {
          broadcastToAll({ type: 'location', user: payload, ts: Date.now() });
        }
        return;
      }

      if (obj.type === 'client_emit' && obj.payload) {
        const to = obj.to || null;
        const out = { type: 'message_created', message: obj.payload, to: to, from: ws._meta.userId, ts: Date.now() };
        if (USE_REDIS && redisPub) {
          try { redisPub.publish('umuy:realtime', JSON.stringify(out)).catch(() => {}); } catch (e) {}
        }
        if (to) broadcastToUser(to, out);
        else broadcastToAll(out);
        return;
      }

    } catch (e) {
      console.warn('message handler error:', String(e));
    }
  });

  ws.on('close', (code, reason) => {
    try {
      console.info('ws closed', { code, reason: reason && reason.toString ? reason.toString() : reason });
      const meta = ws._meta || {};
      if (meta && meta.userId) {
        const set = userConnections.get(meta.userId);
        if (set) {
          set.delete(ws);
          console.info('connection removed for', meta.userId, 'remaining=', set.size);
          if (!set.size) {
            userConnections.delete(meta.userId);
            try { setPresence(meta.userId, false, { last_disconnect: Date.now() }); } catch (e) {}
          }
        }
      }
    } catch (e) {
      console.warn('error during ws close handling', String(e));
    }
  });

  ws.on('error', (err) => {
    try { console.warn('ws error', String(err)); } catch (e) {}
    try { ws.terminate(); } catch (e) {}
  });

});

if (USE_REDIS && redisSub) {
  try {
    redisSub.on('message', (channel, message) => {
      try {
        if (!message) return;
        const obj = safeJsonParse(message);
        if (!obj || !obj.type) return;
        if (obj.type === 'message_created') {
          if (obj.to) broadcastToUser(obj.to, obj); else broadcastToAll(obj);
          return;
        }
        if (obj.type === 'typing') {
          if (obj.to) broadcastToUser(obj.to, obj); return;
        }
        if (obj.type === 'message_delivered' || obj.type === 'message_read' || obj.type === 'message_played' || obj.type === 'recording' || obj.type === 'uploading' || obj.type === 'location' || obj.type === 'presence') {
          if (obj.to) broadcastToUser(obj.to, obj); else broadcastToAll(obj); return;
        }
        if (obj.to) broadcastToUser(obj.to, obj); else broadcastToAll(obj);
      } catch (e) {}
    });
  } catch (e) {
    console.warn('redisSub.on(message) setup failed', String(e));
  }
}

setInterval(() => {
  wss.clients.forEach((client) => {
    try {
      if (!client.isAlive) return client.terminate();
      client.isAlive = false;
      client.ping(() => {});
    } catch (e) {}
  });
}, 30000);

server.listen(PORT, () => {
  console.log(`Realtime WS server listening on port ${PORT} path ${REALTIME_WS_PATH}`);
  if (APP_URL) console.log('App URL:', APP_URL);
  if (!WEBSOCKET_SECRET) console.warn('WEBSOCKET_SECRET not set');
});
