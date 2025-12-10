const http = require('http')
const WebSocket = require('ws')
const port = process.env.PORT || 8080
const server = http.createServer()
const wss = new WebSocket.Server({ noServer: true, path: '/realtime-ws' })
const clients = new Map()
function verifyToken(token){
  if(!token) return null
  try{
    const parts = token.split('.')
    if(parts.length<2) return null
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g,'+').replace(/_/g,'/'),'base64').toString())
    return payload && (payload.sub || payload.user || payload.id) ? String(payload.sub||payload.user||payload.id) : null
  }catch(e){ return null }
}
wss.on('connection',(ws,req,userid)=>{
  ws.isAlive = true
  ws.userId = userid || null
  if(ws.userId) clients.set(ws.userId, clients.get(ws.userId)||new Set()).add(ws)
  ws.send(JSON.stringify({ type:'auth_ok', user: ws.userId }))
  broadcastPresence()
  ws.on('message',msg=>{
    try{
      const d = JSON.parse(msg)
      if(d && d.type === 'typing' && d.to){
        const set = clients.get(d.to)
        if(set) set.forEach(s=> s.send(JSON.stringify({ type:'typing', from: ws.userId, typing: !!d.typing })))
      } else if(d && (d.type === 'message' || d.type === 'message_created')){
        if(d.to){
          const set = clients.get(d.to)
          const out = { type:'message', from: ws.userId, content: d.content || null, media: d.media || null, timestamp: Date.now() }
          if(set) set.forEach(s=> s.send(JSON.stringify(out)))
        }
      }
    }catch(e){}
  })
  ws.on('pong',()=>{ ws.isAlive = true })
  ws.on('close',()=>{ if(ws.userId){ const s = clients.get(ws.userId); if(s){ s.delete(ws); if(!s.size) clients.delete(ws.userId)}; broadcastPresence() } })
})
server.on('upgrade',(req,socket,head)=>{
  let buffered = Buffer.alloc(0)
  req.on('data',chunk => buffered = Buffer.concat([buffered,chunk]))
  const url = new URL(req.url, `http://${req.headers.host}`)
  const token = url.searchParams.get('token')
  const userid = verifyToken(token)
  wss.handleUpgrade(req,socket,head,ws=> wss.emit('connection', ws, req, userid))
})
function broadcastPresence(){
  const presence = Array.from(clients.keys()).map(id=>({ id }))
  wss.clients.forEach(c=> c.send(JSON.stringify({ type:'presence_update', users: presence })))
}
setInterval(()=>{
  wss.clients.forEach(ws=>{
    if(!ws.isAlive) return ws.terminate()
    ws.isAlive = false
    ws.ping(()=>{})
  })
},30000)
server.listen(port,()=>console.log('listening',port))
