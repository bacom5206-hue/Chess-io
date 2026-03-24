// Chess.io — Server with Rooms, Names, Passwords, Draw Offers
// npm install express socket.io
// node server.js
const express = require('express');
const http    = require('http');
const {Server} = require('socket.io');
const path    = require('path');
const app     = express();
const srv     = http.createServer(app);
const io      = new Server(srv,{cors:{origin:'*',methods:['GET','POST']}});

// Serve static files from same directory as server.js
app.use(express.static(__dirname));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── State ────────────────────────────────────────────────────
const rooms  = {};   // roomId → room
const games  = {};   // gameId → game
const names  = {};   // socketId → name
let rid=0, gid=0;

// ── Helpers ──────────────────────────────────────────────────
const sock  = id => io.sockets.sockets.get(id);
const send  = (id,ev,d) => { const s=sock(id); if(s)s.emit(ev,d); };
const bcast = (g,ev,d) => { send(g.white,ev,d); send(g.black,ev,d); };
const pname = id => names[id] || 'Player';

function makeBoard(){
  const b=Array(8).fill(null).map(()=>Array(8).fill(null));
  ['R','N','B','Q','K','B','N','R'].forEach((p,c)=>{b[0][c]='b'+p;b[1][c]='bP';b[6][c]='wP';b[7][c]='w'+p;});
  return b;
}

function freshGame(id, wId, bId, timeMs, inc){
  return {
    id, white:wId, black:bId, board:makeBoard(), turn:'w', moves:[],
    // Store original timeMs so rematch resets to FULL time (fix #6)
    origTimeMs: timeMs,
    clocks:{w:timeMs, b:timeMs}, inc, lastAt:Date.now(), status:'active',
    ep:null, castling:{wK:true,wQ:true,bK:true,bQ:true}, halfmove:0,
    positions:{}, rematch:{}, drawOffer: null
  };
}

function getRoomList(){
  return Object.values(rooms)
    .filter(r => r.status==='waiting')
    .map(r => ({
      id:r.id, name:r.name, host:pname(r.host),
      timeMs:r.timeMs, inc:r.inc,
      hasPassword:!!r.password
    }));
}

function broadcastRoomList(){
  io.emit('roomList', getRoomList());
}

// ── Socket events ─────────────────────────────────────────────
io.on('connection', s => {
  console.log('+', s.id);
  names[s.id] = 'Player';

  s.on('setName', name => {
    names[s.id] = String(name).slice(0,20).trim() || 'Player';
  });

  s.on('getRooms', () => {
    s.emit('roomList', getRoomList());
  });

  s.on('createRoom', data => {
    leaveCurrentRoom(s);
    const id = 'r'+(++rid);
    rooms[id] = {
      id, name: String(data.name||'').slice(0,30)||pname(s.id)+"'s Room",
      host: s.id, password: String(data.password||'').slice(0,20),
      timeMs: Number(data.timeMs)||300000, inc: Number(data.inc)||3000,
      status: 'waiting'
    };
    s.roomId = id;
    s.emit('roomCreated', {roomId:id, room:rooms[id]});
    broadcastRoomList();
  });

  s.on('joinRoom', data => {
    const room = rooms[data.roomId];
    if(!room || room.status!=='waiting') { s.emit('joinError','Room not found or already started'); return; }
    if(room.host === s.id) { s.emit('joinError','You own this room'); return; }
    if(room.password && room.password !== String(data.password||'')) {
      s.emit('joinError','Wrong password'); return;
    }
    leaveCurrentRoom(s);
    room.status = 'playing';
    s.roomId = data.roomId;

    const coin = Math.random() < 0.5;
    const wId = coin ? room.host : s.id;
    const bId = coin ? s.id : room.host;
    const gameId = 'g'+(++gid);
    const game = freshGame(gameId, wId, bId, room.timeMs, room.inc);
    games[gameId] = game;

    const ws = sock(wId), bs = sock(bId);
    if(ws) { ws.gameId=gameId; ws.color='w'; ws.roomId=data.roomId; }
    if(bs) { bs.gameId=gameId; bs.color='b'; bs.roomId=data.roomId; }

    const ini = {id:gameId, board:game.board, clocks:game.clocks, inc:game.inc,
                 whiteName:pname(wId), blackName:pname(bId)};
    send(wId,'start',{...ini,color:'w'});
    send(bId,'start',{...ini,color:'b'});
    broadcastRoomList();
  });

  s.on('cancelRoom', () => {
    leaveCurrentRoom(s);
  });

  s.on('move', d => {
    const g=games[s.gameId];
    if(!g||g.status!=='active'||g.turn!==s.color)return;
    // Moving cancels any pending draw offer
    if(g.drawOffer) {
      const other = g.drawOffer === 'w' ? g.black : g.white;
      send(other, 'drawOfferCancelled', {});
      g.drawOffer = null;
    }
    const now=Date.now();
    g.clocks[s.color]=Math.max(0,g.clocks[s.color]-(now-g.lastAt)+g.inc);
    g.lastAt=now;
    g.board=d.board;g.turn=d.turn;g.ep=d.ep;g.castling=d.castling;g.halfmove=d.halfmove;
    g.moves.push(d.move);
    const pk=JSON.stringify(g.board)+g.turn+JSON.stringify(g.castling)+JSON.stringify(g.ep);
    g.positions[pk]=(g.positions[pk]||0)+1;
    const threefold=g.positions[pk]>=3, fifty=g.halfmove>=100;
    if(d.status!=='active'||threefold||fifty)g.status='over';
    bcast(g,'moved',{...d,color:s.color,clocks:g.clocks,threefold,fifty});
  });

  s.on('chat',({text})=>{
    const g=games[s.gameId];if(!g)return;
    bcast(g,'chat',{color:s.color,name:pname(s.id),text:String(text).slice(0,300).replace(/</g,'&lt;'),ts:Date.now()});
  });

  s.on('resign',()=>{
    const g=games[s.gameId];if(!g||g.status!=='active')return;
    g.status='over';bcast(g,'gameover',{winner:s.color==='w'?'b':'w',reason:'resign'});
  });

  s.on('flag',()=>{
    const g=games[s.gameId];if(!g||g.status!=='active')return;
    g.clocks[g.turn]=Math.max(0,g.clocks[g.turn]-(Date.now()-g.lastAt));
    if(g.clocks[g.turn]<=0){g.status='over';bcast(g,'gameover',{winner:g.turn==='w'?'b':'w',reason:'timeout'});}
  });

  // ── Draw offer system ─────────────────────────────────────
  s.on('offerDraw', () => {
    const g = games[s.gameId];
    if(!g || g.status !== 'active') return;
    if(g.drawOffer === s.color) return; // already pending your offer
    g.drawOffer = s.color;
    const opponent = s.color === 'w' ? g.black : g.white;
    send(opponent, 'drawOffer', { from: s.color });
  });

  s.on('acceptDraw', () => {
    const g = games[s.gameId];
    if(!g || g.status !== 'active' || !g.drawOffer) return;
    if(g.drawOffer === s.color) return; // can't accept own offer
    g.status = 'over';
    g.drawOffer = null;
    bcast(g, 'gameover', { winner: null, reason: 'draw_agreement' });
  });

  s.on('declineDraw', () => {
    const g = games[s.gameId];
    if(!g || !g.drawOffer) return;
    const offerer = g.drawOffer === 'w' ? g.white : g.black;
    g.drawOffer = null;
    send(offerer, 'drawDeclined', {});
  });

  // Rematch — FIX: use origTimeMs so clocks reset to full time
  s.on('rematch',()=>{
    const g=games[s.gameId];if(!g)return;
    g.rematch[s.color]=true;
    send(s.color==='w'?g.black:g.white,'rematchOffer',{});
    if(g.rematch.w&&g.rematch.b){
      const ng=freshGame(g.id, g.black, g.white, g.origTimeMs, g.inc);
      games[g.id]=ng;
      const ws=sock(ng.white),bs=sock(ng.black);
      const ini={id:ng.id,board:ng.board,clocks:ng.clocks,inc:ng.inc,whiteName:pname(ng.white),blackName:pname(ng.black)};
      if(ws){ws.color='w';ws.emit('rematchStart',{...ini,color:'w'});}
      if(bs){bs.color='b';bs.emit('rematchStart',{...ini,color:'b'});}
    }
  });

  s.on('disconnect',()=>{
    console.log('-',s.id);
    leaveCurrentRoom(s);
    const g=games[s.gameId];
    if(g&&g.status==='active'){
      g.status='over';
      send(s.color==='w'?g.black:g.white,'gameover',{winner:s.color==='w'?'b':'w',reason:'disconnect'});
    }
    delete names[s.id];
  });

  function leaveCurrentRoom(s){
    if(!s.roomId) return;
    const room = rooms[s.roomId];
    if(room && room.status==='waiting' && room.host===s.id){
      delete rooms[s.roomId];
      broadcastRoomList();
    }
    s.roomId = null;
  }
});

const PORT=process.env.PORT||3000;
srv.listen(PORT,()=>{
  console.log('Chess.io →', 'http://localhost:'+PORT);
});
