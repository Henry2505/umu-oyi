'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bodyParser = require('body-parser');
const helmet = require('helmet');

const REDIS_URL = process.env.REDIS_URL || '';
const WEBSOCKET_SECRET = process.env.WEBSOCKET_SECRET || ''; // set a secret token for /emit auth
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
  redisSub.subscribe('umuy:realtime').catch(err => console.error('redis sub err', err));
  console.log('Redis pub/sub enabled');
}

const app = express();
app.use(helmet());
app.use(bodyParser.json({ limit: '1mb' }));

// ---- Basic in-memory maps
// Map userId -> Set of ws connections (a user could be connected from multiple devices)
const userConnections = new Map();

// util
function safeJsonParse(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}
function sendWs(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch (e) {}
}
function broadcastToUser(userId, payload) {
  const set = userConnections.get(String(userId));
  if (!set || !set.size) return;
  for (const c of Array.from(set)) {
    if (c.readyState === WebSocket.OPEN) {
      sendWs(c, payload);
    } else {
      try { c.terminate(); } catch(e) {}
      set.delete(c);
    }
  }
}

// HTTP health check
app.get('/health', (req,res) => res.json({ ok: true, pid: process.pid, ws_path: REALTIME_WS_PATH }));

// /emit - called by your backend AFTER saving message to DB
// requires WEBSOCKET_SECRET to be set and provided by header 'x-realtime-secret' or query param ?secret=
app.post('/emit', async (req, res) => {
  try {
    const provided = (req.headers['x-realtime-secret'] || req.query.secret || '').toString();
    if (!WEBSOCKET_SECRET || provided !== WEBSOCKET_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const payload = req.body || {};
    // expected { type: 'message_created', message: {...}, to: "<userId>" }
    if (!payload || !payload.type) return res.status(400).json({ error: 'Bad payload' });

    // publish to Redis so other instances pick up
    const envelope = { type: payload.type, message: payload.message || null, to: payload.to || null, meta: payload.meta || null, ts: Date.now() };
    if (USE_REDIS && redisPub) {
      try { await redisPub.publish('umuy:realtime', JSON.stringify(envelope)); } catch (e) { console.warn('redis publish failed', e); }
    }
    // local broadcast
    if (envelope.type === 'message_created') {
      // if payload.to is set -> send to that user
      if (envelope.to) broadcastToUser(envelope.to, envelope);
      else {
        // public broadcast to all
        for (const [uid, set] of userConnections.entries()) {
          for (const c of set) {
            if (c.readyState === WebSocket.OPEN) sendWs(c, envelope);
          }
        }
      }
    } else {
      // generic broadcast to target or all
      if (envelope.to) broadcastToUser(envelope.to, envelope);
      else {
        for (const [uid, set] of userConnections.entries()) {
          for (const c of set) {
            if (c.readyState === WebSocket.OPEN) sendWs(c, envelope);
          }
        }
      }
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('/emit error', err);
    return res.status(500).json({ error: String(err) });
  }
});

// create server + ws
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: REALTIME_WS_PATH });

// function to safely close ws with code & reason
function closeWsWithReason(ws, code = 1008, reason = 'Policy') {
  try { ws.send(JSON.stringify({ type: 'error', reason })); } catch (e) {}
  try { ws.close(code, reason); } catch (e) {}
}

wss.on('connection', (ws, req) => {
  ws._meta = { authenticated: false, userId: null, createdAt: Date.now() };

  // simple origin check (best-effort; origin header can be absent for native clients)
  try {
    const origin = (req.headers && req.headers.origin) ? req.headers.origin : null;
    if (ALLOWED_ORIGINS.length && origin && !ALLOWED_ORIGINS.includes(origin)) {
      console.warn('Connection from disallowed origin', origin);
      closeWsWithReason(ws, 4003, 'origin_not_allowed');
      return;
    }
  } catch (e) {}

  // a small ping/pong keepalive
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    let msg = data;
    if (Buffer.isBuffer(msg)) msg = msg.toString();
    let obj = safeJsonParse(msg);
    if (!obj) return;
    // handshake: { type: 'auth', token: '<user-id-or-jwt>' }
    if (obj.type === 'auth') {
      // Accept either direct user id or a JWT-like token; you can customize verification here.
      const token = (obj.token || '').toString();
      if (!token) {
        sendWs(ws, { type: 'auth_failed', reason: 'no token' }); ws.close(4001, 'no token'); return;
      }
      // NOTE: For production you should verify JWTs properly. Here we accept token as userId.
      const userId = token; // Replace with verification if desired
      ws._meta.authenticated = true;
      ws._meta.userId = String(userId);
      // add to map
      const set = userConnections.get(ws._meta.userId) || new Set();
      set.add(ws);
      userConnections.set(ws._meta.userId, set);
      sendWs(ws, { type: 'auth_ok', userId: ws._meta.userId });
      console.log('user connected', ws._meta.userId, 'connections=', userConnections.get(ws._meta.userId).size);
      return;
    }

    // simple client ping/pong or other messages: you can add typing, presence, etc.
    if (obj.type === 'ping') { sendWs(ws, { type: 'pong' }); return; }
    if (obj.type === 'typing') {
      // { type: 'typing', to: '<userId>', typing: true|false }
      if (obj.to) {
        const out = { type: 'typing', from: ws._meta.userId, to: obj.to, typing: !!obj.typing, ts: Date.now() };
        // publish to redis and local
        if (USE_REDIS && redisPub) redisPub.publish('umuy:realtime', JSON.stringify(out)).catch(()=>{});
        if (out.to) broadcastToUser(out.to, out);
      }
      return;
    }

    // allow clients to emit messages directly (not recommended unless you do DB persist)
    if (obj.type === 'client_emit' && obj.payload) {
      // echo to target (will not persist)
      if (obj.to) {
        const out = { type: 'message_created', message: obj.payload, to: obj.to, from: ws._meta.userId, ts: Date.now() };
        if (USE_REDIS && redisPub) redisPub.publish('umuy:realtime', JSON.stringify(out)).catch(()=>{});
        if (out.to) broadcastToUser(out.to, out);
      }
    }
  });

  ws.on('close', () => {
    try {
      const meta = ws._meta || {};
      if (meta && meta.userId) {
        const set = userConnections.get(meta.userId);
        if (set) {
          set.delete(ws);
          if (!set.size) userConnections.delete(meta.userId);
        }
      }
    } catch (e) {}
  });

  ws.on('error', () => { try { ws.terminate(); } catch (e) {} });
});

// Redis subscription handler: when message arrives from other instance, broadcast locally
if (USE_REDIS && redisSub) {
  redisSub.on('message', (channel, message) => {
    try {
      if (!message) return;
      const obj = safeJsonParse(message);
      if (!obj || !obj.type) return;
      if (obj.type === 'message_created') {
        if (obj.to) broadcastToUser(obj.to, obj);
        else {
          for (const set of userConnections.values()) {
            for (const c of set) if (c.readyState === WebSocket.OPEN) sendWs(c, obj);
          }
        }
      } else if (obj.type === 'typing') {
        if (obj.to) broadcastToUser(obj.to, obj);
      } else {
        // generic
        if (obj.to) broadcastToUser(obj.to, obj);
        else {
          for (const set of userConnections.values()) {
            for (const c of set) if (c.readyState === WebSocket.OPEN) sendWs(c, obj);
          }
        }
      }
    } catch (e) { console.error('redisSub message handler', e); }
  });
}

// server-side ping to detect dead clients
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, 30000);

server.listen(PORT, () => {
  console.log(`Realtime WS server listening on port ${PORT} path ${REALTIME_WS_PATH}`);
  if (APP_URL) console.log('App URL:', APP_URL);
  if (!WEBSOCKET_SECRET) console.warn('Warning: WEBSOCKET_SECRET not set. /emit is unprotected; set WEBSOCKET_SECRET env var.');
});
