'use strict';
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bodyParser = require('body-parser');
const helmet = require('helmet');

const REDIS_URL = process.env.REDIS_URL || '';
const WEBSOCKET_SECRET = process.env.WEBSOCKET_SECRET || '';
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET || '';
const PORT = process.env.PORT || 3000;
const REALTIME_WS_PATH = (process.env.REALTIME_WS_PATH || '/realtime-ws').replace(/\/+$/, '') || '/realtime-ws';
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
    redisSub.subscribe('umuy:realtime').catch(() => {});
    console.info('Redis enabled for realtime presence/pubsub');
  } catch (err) {
    console.warn('Failed to init Redis, continuing without it:', String(err));
    redis = null;
    redisPub = null;
    redisSub = null;
  }
} else {
  console.info('Redis disabled (REDIS_URL not set)');
}

let jwt = null;
if (SUPABASE_JWT_SECRET) {
  try {
    jwt = require('jsonwebtoken');
  } catch (e) {
    console.warn('jsonwebtoken not available; JWT verification disabled');
    jwt = null;
  }
} else {
  console.warn('SUPABASE_JWT_SECRET not set; JWT verification disabled (will try best-effort decode)');
}

const app = express();
app.use(helmet());
app.use(bodyParser.json({ limit: '4mb' }));

const userConnections = new Map();
const lastSeenMap = new Map();

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

function maskToken(t) {
  try {
    if (!t) return '';
    const s = String(t);
    if (s.length <= 8) return '****';
    return s.slice(0, 4) + '…' + s.slice(-4) + ` (len=${s.length})`;
  } catch (e) { return '****'; }
}

function sendWs(ws, obj) {
  try {
    try {
      const summary = { type: obj && obj.type ? obj.type : '<no-type>' };
      if (obj && obj.userId) summary.userId = obj.userId;
      if (obj && obj.user && obj.user.id) summary.user = obj.user.id;
      if (obj && obj.reason) summary.reason = obj.reason;
      if (obj && obj.token) summary.token = maskToken(obj.token);
      console.info('send ->', summary);
    } catch (e) {}
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  } catch (e) {
    try { ws.terminate(); } catch (err) {}
  }
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
    if (set.size === 0) userConnections.delete(String(userId));
  } catch (e) {}
}

function broadcastToAll(payload) {
  try {
    for (const [uid, set] of userConnections.entries()) {
      for (const c of Array.from(set)) {
        try {
          if (c.readyState === WebSocket.OPEN) sendWs(c, payload);
          else {
            try { c.terminate(); } catch (e) {}
            set.delete(c);
          }
        } catch (e) {}
      }
      if (set.size === 0) userConnections.delete(uid);
    }
  } catch (e) {}
}

async function setPresence(userId, online, extra) {
  try {
    const key = `presence:${userId}`;
    const now = Date.now();
    const payload = { id: String(userId), online: !!online, last_seen: online ? null : now, updated_at: now };
    if (extra && typeof extra === 'object') payload.meta = extra;
    lastSeenMap.set(String(userId), payload);
    if (USE_REDIS && redis) {
      try { redis.set(key, JSON.stringify(payload), 'EX', 60 * 60 * 24).catch(() => {}); } catch (e) {}
      try { if (redisPub) redisPub.publish('umuy:realtime', JSON.stringify({ type: 'presence', user: payload, ts: now })).catch(() => {}); } catch (e) {}
    } else {
      try { broadcastToAll({ type: 'presence', user: payload, ts: now }); } catch (e) {}
    }
    console.info(`presence (in-memory) ${userId} online=${!!online}`);
    return payload;
  } catch (e) {
    console.warn('setPresence error', String(e));
    return null;
  }
}

async function getPresence(userId) {
  try {
    const key = `presence:${userId}`;
    const local = lastSeenMap.get(String(userId));
    if (local) return local;
    if (USE_REDIS && redis) {
      try {
        const p = redis.get(key);
        const res = await Promise.race([p, new Promise(r => setTimeout(() => r(null), 500))]);
        if (res) return safeJsonParse(res);
      } catch (e) {}
    }
    return lastSeenMap.get(String(userId)) || null;
  } catch (e) { return null; }
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

app.get(REALTIME_WS_PATH, (req, res) => {
  res.json({ ok: true, ws_path: REALTIME_WS_PATH, clients: wss ? wss.clients.size : 0 });
});

function requireSecret(req, res, next) {
  const provided = (req.headers['x-realtime-secret'] || req.query.secret || '').toString();
  if (WEBSOCKET_SECRET && provided === WEBSOCKET_SECRET) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

app.get('/connections', requireSecret, (req, res) => {
  const out = [];
  for (const [uid, set] of userConnections.entries()) {
    out.push({ userId: uid, connections: set.size });
  }
  res.json({ ok: true, count: out.length, list: out });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function closeWsWithReason(ws, code = 1008, reason = 'Policy') {
  try { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', reason })); } catch (e) {}
  try { if (ws) ws.close(code, reason); } catch (e) {}
}

function extractTokenFromCookieString(cookieStr) {
  try {
    if (!cookieStr) return null;
    const m = cookieStr.match(/(?:^|; )(?:sb-jwt-token|sb-access-token|umuy_token|access_token|token|umu_token)=([^;]+)/);
    if (m) return decodeURIComponent(m[1]);
  } catch (e) {}
  return null;
}

function tryAutoAuthFromReq(req) {
  try {
    const url = req && req.url ? req.url : '';
    try {
      const idx = url.indexOf('?');
      if (idx !== -1) {
        const qs = url.slice(idx + 1);
        const params = new URLSearchParams(qs);
        const t = params.get('token');
        if (t) {
          console.info('auto-token found in query:', maskToken(t), 'req.url=', url);
          return t;
        }
      }
    } catch (e) {}
    const cookieHeader = req && req.headers && (req.headers.cookie || req.headers.Cookie) ? (req.headers.cookie || req.headers.Cookie) : '';
    const cToken = extractTokenFromCookieString(cookieHeader);
    if (cToken) {
      console.info('auto-token found in cookie header:', maskToken(cToken), 'cookieHeader=', cookieHeader ? '[present]' : '[none]');
      return cToken;
    }
    console.info('no auto-token found on ws handshake; url=', url, 'origin=', req && req.headers && req.headers.origin ? req.headers.origin : '<none>');
    return null;
  } catch (e) { return null; }
}

async function verifyAndExtractUserId(token) {
  try {
    if (!token) return null;
    let userId = null;
    if (jwt && SUPABASE_JWT_SECRET && token.indexOf('.') > -1) {
      try {
        const payload = jwt.verify(token, SUPABASE_JWT_SECRET);
        userId = payload && (payload.sub || payload.user_id || payload.user || payload.id) ? String(payload.sub || payload.user_id || payload.user || payload.id) : null;
        console.info('JWT verified via SUPABASE_JWT_SECRET mask=', maskToken(token));
        return userId || token;
      } catch (e) {
        console.warn('JWT verify failed:', String(e), 'mask=', maskToken(token));
        return null;
      }
    }
    if (token.indexOf('.') > -1) {
      try {
        const parts = token.split('.');
        const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
        userId = payload && (payload.sub || payload.user_id || payload.user || payload.id) ? String(payload.sub || payload.user_id || payload.user || payload.id) : null;
        console.info('JWT decoded without verify mask=', maskToken(token));
        return userId || token;
      } catch (e) {
        console.warn('JWT decode failed:', String(e));
        return null;
      }
    }
    return String(token);
  } catch (e) {
    return null;
  }
}

wss.on('connection', (ws, req) => {
  ws._meta = { authenticated: false, userId: null, createdAt: Date.now() };
  try {
    const origin = (req.headers && req.headers.origin) ? req.headers.origin : null;
    const requestUrl = (req && req.url) ? req.url.split('?')[0] : '/';
    console.info('ws connection open - remoteAddr:', (req.socket && (req.socket.remoteAddress || req.socket.remoteFamily)) || '<unknown>',
      'url:', req.url || '<no-url>',
      'origin:', origin || '<none>',
      'cookie-present:', !!(req.headers && (req.headers.cookie || req.headers.Cookie)));
    if (ALLOWED_ORIGINS.length && origin && !ALLOWED_ORIGINS.includes(origin)) {
      console.warn('origin not allowed:', origin);
      closeWsWithReason(ws, 4003, 'origin_not_allowed');
      return;
    }
    if (!(requestUrl === REALTIME_WS_PATH || requestUrl === '/' || requestUrl === '/')) {
      console.info('ws connected to unexpected path:', requestUrl, 'allowed path:', REALTIME_WS_PATH);
    }
  } catch (e) {
    console.warn('origin check error', String(e));
  }

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  try {
    const autoToken = tryAutoAuthFromReq(req);
    if (autoToken) {
      (async (token) => {
        try {
          const userId = await verifyAndExtractUserId(token);
          if (!userId) {
            console.info('auto-token present but could not verify/extract user id mask=', maskToken(token));
            return;
          }
          ws._meta.authenticated = true;
          ws._meta.userId = String(userId);
          const set = userConnections.get(ws._meta.userId) || new Set();
          set.add(ws);
          userConnections.set(ws._meta.userId, set);
          setPresence(ws._meta.userId, true).catch(() => {});
          sendWs(ws, { type: 'auth_ok', userId: ws._meta.userId });
          const presence = await getPresence(ws._meta.userId);
          sendWs(ws, { type: 'presence_snapshot', user: presence || { id: ws._meta.userId, online: true } });
          console.info('auto-authenticated connection for user mask=', maskToken(token), 'userId=', ws._meta.userId);
        } catch (e) {
          console.warn('auto-auth register error', String(e));
        }
      })(autoToken);
    } else {
      console.info('no auto-token found on ws connect; waiting for client auth message');
    }
  } catch (e) {
    console.warn('auto-auth attempt error', String(e));
  }

  ws.on('message', async (data) => {
    try {
      let msg = data;
      if (Buffer.isBuffer(msg)) msg = msg.toString();
      const rawPreview = (typeof msg === 'string') ? (msg.length > 200 ? msg.slice(0, 200) + '… (truncated)' : msg) : '[non-string]';
      console.debug('ws message received (raw preview):', rawPreview);
      const obj = safeJsonParse(msg);
      if (!obj) {
        console.debug('ws message: not JSON or failed parse');
        return;
      }
      if (obj.type === 'auth') {
        const token = (obj.token || '').toString();
        console.info('auth message received token=', maskToken(token));
      } else {
        console.info('ws message parsed:', { type: obj.type || '<none>', keys: Object.keys(obj).slice(0, 10) });
      }
      if (!obj || !obj.type) return;

      if (obj.type === 'auth') {
        const token = (obj.token || '').toString();
        if (!token) {
          sendWs(ws, { type: 'auth_failed', reason: 'no token' });
          try { ws.close(4001, 'no token'); } catch (e) {}
          return;
        }
        const userId = await verifyAndExtractUserId(token);
        if (!userId) {
          sendWs(ws, { type: 'auth_failed', reason: 'invalid_token' });
          try { ws.close(4002, 'invalid_token'); } catch (e) {}
          return;
        }
        ws._meta.authenticated = true;
        ws._meta.userId = String(userId);
        const set = userConnections.get(ws._meta.userId) || new Set();
        set.add(ws);
        userConnections.set(ws._meta.userId, set);
        try { setPresence(ws._meta.userId, true).catch(() => {}); } catch (e) {}
        sendWs(ws, { type: 'auth_ok', userId: ws._meta.userId });
        const presence = await getPresence(ws._meta.userId);
        sendWs(ws, { type: 'presence_snapshot', user: presence || { id: ws._meta.userId, online: true } });
        return;
      }

      if (!ws._meta || !ws._meta.authenticated) {
        sendWs(ws, { type: 'error', reason: 'not_authenticated' });
        try { ws.close(4003, 'not_authenticated'); } catch (e) {}
        return;
      }

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
        const lat = obj.lat || null; const lon = obj.lon || null; const acc = obj.accuracy || null; const ts = obj.timestamp || Date.now();
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
      if (!client.isAlive) {
        try { client.terminate(); } catch (e) {}
        return;
      }
      client.isAlive = false;
      try { client.ping(() => {}); } catch (e) {}
    } catch (e) {}
  });
}, 30000);

process.on('uncaughtException', (err) => {
  try { console.error('uncaughtException', String(err)); } catch (e) {}
});

process.on('unhandledRejection', (reason) => {
  try { console.error('unhandledRejection', String(reason)); } catch (e) {}
});

server.listen(PORT, () => {
  console.log(`Realtime WS server listening on port ${PORT} path ${REALTIME_WS_PATH}`);
  if (APP_URL) console.log('App URL:', APP_URL);
  if (!WEBSOCKET_SECRET) console.warn('WEBSOCKET_SECRET not set');
  if (!SUPABASE_JWT_SECRET) console.warn('SUPABASE_JWT_SECRET not set; JWT verification disabled');
});
