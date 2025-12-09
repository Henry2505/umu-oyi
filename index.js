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
  const IORedis = require('ioredis');
  redisPub = new IORedis(REDIS_URL);
  redisSub = new IORedis(REDIS_URL);
  redis = new IORedis(REDIS_URL);
  redisSub.subscribe('umuy:realtime').catch(() => {});
}
const app = express();
app.use(helmet());
app.use(bodyParser.json({ limit: '2mb' }));
const userConnections = new Map();
const lastSeenMap = new Map();
function safeJsonParse(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}
function sendWs(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch (e) {}
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
async function setPresence(userId, online, extra) {
  try {
    const key = `presence:${userId}`;
    const now = Date.now();
    const payload = { id: String(userId), online: !!online, last_seen: online ? null : now, updated_at: now };
    if (extra && typeof extra === 'object') payload.meta = extra;
    lastSeenMap.set(String(userId), payload);
    if (USE_REDIS && redis) {
      try { await redis.set(key, JSON.stringify(payload), 'EX', 60 * 60 * 24); } catch (e) {}
      try { await redis.publish('umuy:realtime', JSON.stringify({ type: 'presence', user: payload, ts: now })); } catch (e) {}
    } else {
      try { await Promise.resolve(); } catch (e) {}
      try { broadcastToAll({ type: 'presence', user: payload, ts: now }); } catch (e) {}
    }
  } catch (e) {}
}
async function getPresence(userId) {
  try {
    const key = `presence:${userId}`;
    if (USE_REDIS && redis) {
      try {
        const v = await redis.get(key);
        if (v) return safeJsonParse(v);
      } catch (e) {}
    }
    return lastSeenMap.get(String(userId)) || null;
  } catch (e) { return null; }
}
app.get('/health', (req,res) => {
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
      try { await redisPub.publish('umuy:realtime', JSON.stringify(envelope)); } catch (e) {}
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
    if (ALLOWED_ORIGINS.length && origin && !ALLOWED_ORIGINS.includes(origin)) {
      closeWsWithReason(ws, 4003, 'origin_not_allowed');
      return;
    }
  } catch (e) {}
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', async (data) => {
    try {
      let msg = data;
      if (Buffer.isBuffer(msg)) msg = msg.toString();
      const obj = safeJsonParse(msg);
      if (!obj || !obj.type) return;
      if (obj.type === 'auth') {
        const token = (obj.token || '').toString();
        if (!token) {
          sendWs(ws, { type: 'auth_failed', reason: 'no token' });
          ws.close(4001, 'no token');
          return;
        }
        let userId = token;
        if (token.indexOf('.') > -1) {
          try {
            const parts = token.split('.');
            const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
            userId = payload.sub || payload.user_id || payload.user || payload.id || userId;
          } catch (e) { userId = token; }
        }
        ws._meta.authenticated = true;
        ws._meta.userId = String(userId);
        const set = userConnections.get(ws._meta.userId) || new Set();
        set.add(ws);
        userConnections.set(ws._meta.userId, set);
        try { await setPresence(ws._meta.userId, true); } catch (e) {}
        sendWs(ws, { type: 'auth_ok', userId: ws._meta.userId });
        const presence = await getPresence(ws._meta.userId);
        sendWs(ws, { type: 'presence_snapshot', user: presence || { id: ws._meta.userId, online: true } });
        return;
      }
      if (!ws._meta || !ws._meta.authenticated) {
        sendWs(ws, { type: 'error', reason: 'not_authenticated' });
        ws.close(4003, 'not_authenticated');
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
          try { await redisPub.publish('umuy:realtime', JSON.stringify(out)); } catch (e) {}
        }
        if (to) broadcastToUser(to, out);
        return;
      }
      if (obj.type === 'delivered' || obj.type === 'message_delivered') {
        const to = obj.to || null;
        const out = { type: 'message_delivered', id: obj.id || obj.messageId || null, from: ws._meta.userId, to: to, ts: Date.now() };
        if (USE_REDIS && redisPub) {
          try { await redisPub.publish('umuy:realtime', JSON.stringify(out)); } catch (e) {}
        }
        if (to) broadcastToUser(to, out);
        return;
      }
      if (obj.type === 'read' || obj.type === 'message_read') {
        const to = obj.to || null;
        const out = { type: 'message_read', id: obj.id || obj.messageId || null, from: ws._meta.userId, to: to, ts: Date.now() };
        if (USE_REDIS && redisPub) {
          try { await redisPub.publish('umuy:realtime', JSON.stringify(out)); } catch (e) {}
        }
        if (to) broadcastToUser(to, out);
        return;
      }
      if (obj.type === 'message_played') {
        const to = obj.to || null;
        const out = { type: 'message_played', id: obj.id || null, from: ws._meta.userId, to: to, ts: Date.now() };
        if (USE_REDIS && redisPub) {
          try { await redisPub.publish('umuy:realtime', JSON.stringify(out)); } catch (e) {}
        }
        if (to) broadcastToUser(to, out);
        return;
      }
      if (obj.type === 'recording') {
        const to = obj.to || null;
        const out = { type: 'recording', from: ws._meta.userId, to: to, status: obj.status || 'start', ts: Date.now() };
        if (USE_REDIS && redisPub) {
          try { await redisPub.publish('umuy:realtime', JSON.stringify(out)); } catch (e) {}
        }
        if (to) broadcastToUser(to, out);
        return;
      }
      if (obj.type === 'uploading') {
        const to = obj.to || null;
        const out = { type: 'uploading', from: ws._meta.userId, to: to, status: obj.status || 'start', progress: obj.progress || 0, ts: Date.now() };
        if (USE_REDIS && redisPub) {
          try { await redisPub.publish('umuy:realtime', JSON.stringify(out)); } catch (e) {}
        }
        if (to) broadcastToUser(to, out);
        return;
      }
      if (obj.type === 'location') {
        const lat = obj.lat || null;
        const lon = obj.lon || null;
        const acc = obj.accuracy || null;
        const ts = obj.timestamp || Date.now();
        const payload = { id: ws._meta.userId, location: { lat, lon, accuracy: acc, ts }, updated_at: Date.now() };
        const key = `presence:${ws._meta.userId}`;
        try {
          if (USE_REDIS && redis) {
            try { await redis.set(key, JSON.stringify(Object.assign({}, (await getPresence(ws._meta.userId)) || {}, { id: ws._meta.userId, online: true, location: payload.location, updated_at: Date.now() })), 'EX', 60 * 60 * 24); } catch (e) {}
            try { await redis.publish('umuy:realtime', JSON.stringify({ type: 'location', user: payload, to: obj.to || null, ts: Date.now() })); } catch (e) {}
          } else {
            lastSeenMap.set(String(ws._meta.userId), Object.assign({}, lastSeenMap.get(String(ws._meta.userId)) || {}, { id: ws._meta.userId, online: true, location: payload.location, updated_at: Date.now() }));
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
          try { await redisPub.publish('umuy:realtime', JSON.stringify(out)); } catch (e) {}
        }
        if (to) broadcastToUser(to, out);
        else broadcastToAll(out);
        return;
      }
    } catch (e) {}
  });
  ws.on('close', async () => {
    try {
      const meta = ws._meta || {};
      if (meta && meta.userId) {
        const set = userConnections.get(meta.userId);
        if (set) {
          set.delete(ws);
          if (!set.size) {
            userConnections.delete(meta.userId);
            await setPresence(meta.userId, false, { last_disconnect: Date.now() });
            broadcastToAll({ type: 'presence', user: { id: meta.userId, online: false, last_seen: Date.now() }, ts: Date.now() });
          }
        }
      }
    } catch (e) {}
  });
  ws.on('error', () => { try { ws.terminate(); } catch (e) {} });
});
if (USE_REDIS && redisSub) {
  redisSub.on('message', (channel, message) => {
    try {
      if (!message) return;
      const obj = safeJsonParse(message);
      if (!obj || !obj.type) return;
      if (obj.type === 'message_created') {
        if (obj.to) broadcastToUser(obj.to, obj);
        else broadcastToAll(obj);
        return;
      }
      if (obj.type === 'typing') {
        if (obj.to) broadcastToUser(obj.to, obj);
        return;
      }
      if (obj.type === 'message_delivered' || obj.type === 'message_read' || obj.type === 'message_played' || obj.type === 'recording' || obj.type === 'uploading' || obj.type === 'location' || obj.type === 'presence') {
        if (obj.to) broadcastToUser(obj.to, obj);
        else broadcastToAll(obj);
        return;
      }
      if (obj.to) broadcastToUser(obj.to, obj);
      else broadcastToAll(obj);
    } catch (e) {}
  });
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
