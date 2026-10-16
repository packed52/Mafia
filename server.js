const express = require('express'), http = require('http'), path = require('path'), crypto = require('crypto');
const { Server } = require('socket.io');
const app = express(), server = http.createServer(app), io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));
app.get('/room/:id', (q, s) => s.sendFile(path.join(__dirname, 'public/index.html')));

const rooms = new Map();
const ROLES = ['civilian', 'mafia', 'don', 'commissar', 'doctor', 'hooker', 'hobo'];
const UNIQUE = ['don', 'commissar', 'doctor', 'hooker', 'hobo'];
const isMaf = p => p.role === 'mafia' || p.role === 'don';
const RU = { civilian: 'Мирный житель', mafia: 'Мафия', don: 'Дон мафии', commissar: 'Комиссар', doctor: 'Доктор', hooker: 'Любовница', hobo: 'Бомж' };
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const clamp = (v, lo, hi, d) => { v = parseInt(v, 10); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
const clean = (s, n) => String(s || '').replace(/[<>]/g, '').trim().slice(0, n);

// ---------- состояние для клиента (роли скрыты от чужих глаз) ----------
function view(r, pid) {
  const me = r.players.find(p => p.id === pid);
  const over = r.phase === 'GAME_OVER';
  return {
    now: Date.now(), roomId: r.id, phase: r.phase, deadline: r.deadline, winner: r.winner, settings: r.settings,
    revealed: r.players.filter(p => p.revealed).length,
    players: r.players.map(p => ({
      id: p.id, name: p.name, alive: p.alive, online: p.online, host: p.id === r.hostId,
      role: (over || !p.alive || p.id === pid || (r.known && me && isMaf(me) && isMaf(p))) ? p.role : null,
      vote: r.phase === 'VOTING' ? (r.votes[p.id] || null) : null
    })),
    you: me && { id: me.id, role: me.role, revealed: me.revealed, acts: r.acts[pid] || {} }
  };
}
const broadcast = r => r.players.forEach(p => p.online && io.to(p.sid).emit('state', view(r, p.id)));
const sees = (p, m) => m.to ? p.id === m.to : m.scope === 'mafia' ? isMaf(p) : true;
function say(r, m) {
  r.chat.push(m); if (r.chat.length > 150) r.chat.shift();
  r.players.forEach(p => p.online && sees(p, m) && io.to(p.sid).emit('chat', m));
}
const sys = (r, text, to) => say(r, { scope: 'sys', text, to });

function go(r, phase, sec, next) {
  clearTimeout(r.timer); r.phase = phase;
  r.deadline = sec ? Date.now() + sec * 1000 : null;
  if (sec && next) r.timer = setTimeout(() => next(r), sec * 1000);
  broadcast(r);
}

// ---------- ход игры ----------
function checkWin(r) {
  const al = r.players.filter(p => p.alive), black = al.filter(isMaf).length, other = al.length - black;
  const w = black === 0 ? 'red' : black >= other ? 'black' : null;
  if (!w) return false;
  r.winner = w; sys(r, w === 'red' ? 'Мафия разоблачена. Победа мирных жителей!' : 'Мафия захватила город. Победа мафии!');
  go(r, 'GAME_OVER', 0); return true;
}

function startNight(r) {
  r.acts = {}; sys(r, 'Город засыпает. Просыпается мафия.');
  go(r, 'NIGHT', r.settings.nightTime, resolveNight);
}

function resolveNight(r) {
  clearTimeout(r.timer);
  const al = r.players.filter(p => p.alive), by = role => al.find(p => p.role === role);
  const A = (p, k = 'act') => { const t = p && r.acts[p.id] && r.acts[p.id][k]; return t && t !== 'skip' ? t : null; };
  const get = id => r.players.find(p => p.id === id);
  const hk = by('hooker'), dc = by('doctor'), cm = by('commissar'), hb = by('hobo'), dn = by('don');
  const block = A(hk), blockedP = get(block), blocked = id => block === id;
  const visits = {}, visit = (t, who) => { if (t) (visits[t] = visits[t] || []).push(who.name); };
  const priv = (p, text) => p && sys(r, text, p.id);

  visit(block, hk);
  // выстрел мафии: побеждает цель с наибольшим числом голосов, при ничьей решает Дон
  let shot = null, shooters = [];
  const votes = al.filter(isMaf).map(p => [p, A(p, 'kill')]).filter(v => v[1]);
  const cnt = {}; votes.forEach(([, t]) => cnt[t] = (cnt[t] || 0) + 1);
  const max = Math.max(0, ...Object.values(cnt)), top = Object.keys(cnt).filter(t => cnt[t] === max);
  if (top.length) shot = top.length === 1 ? top[0] : (top.includes(A(dn, 'kill')) ? A(dn, 'kill') : top[crypto.randomInt(top.length)]);
  if (blockedP && isMaf(blockedP)) { shot = null; al.filter(isMaf).forEach(p => priv(p, 'Любовница отвлекла вас: выстрела не будет.')); }
  if (shot) votes.filter(v => v[1] === shot).forEach(([p]) => visit(shot, p));

  // доктор
  let heal = null;
  if (dc) {
    if (blocked(dc.id)) { priv(dc, 'Вас заблокировали. Лечения не будет.'); r.doctorSelfLast = false; }
    else { heal = A(dc); visit(heal, dc); r.doctorSelfLast = heal === dc.id; }
  }
  let victim = shot && shot !== heal ? get(shot) : null;
  if (victim) victim.alive = false;

  // комиссар и дон
  if (cm) {
    if (blocked(cm.id)) priv(cm, 'Вас заблокировали. Проверки не будет.');
    else { const t = get(A(cm)); if (t) { visit(t.id, cm); priv(cm, `${t.name}: ${isMaf(t) ? 'принадлежит мафии' : 'не мафия'}.`); } }
  }
  if (dn) {
    if (blocked(dn.id)) priv(dn, 'Вас заблокировали. Проверки не будет.');
    else { const t = get(A(dn)); if (t) priv(dn, `${t.name}: ${t.role === 'commissar' ? 'это Комиссар!' : 'не Комиссар.'}`); }
  }
  // бомж
  if (hb) {
    if (blocked(hb.id)) priv(hb, 'Вас заблокировали. Вы ничего не увидели.');
    else {
      const t = get(A(hb));
      if (t) { const v = (visits[t.id] || []); priv(hb, v.length ? `К ${t.name} приходили: ${v.join(', ')}.` : `К ${t.name} никто не приходил.`); }
    }
  }

  sys(r, victim ? `Утро. Этой ночью погиб(ла) ${victim.name}.` : 'Утро. Этой ночью никто не погиб.');
  if (victim) io.to(r.id).emit('toast', `${victim.name} убит(а)`);
  if (!checkWin(r)) startDay(r);
}

function startDay(r) {
  r.votes = {}; sys(r, 'Начинается обсуждение. Найдите мафию.');
  go(r, 'DAY', r.settings.discussionTime, startVoting);
}
function startVoting(r) {
  r.votes = {}; sys(r, 'Голосование! Выберите, кто покинет город.');
  go(r, 'VOTING', 30, tally);
}
function tally(r) {
  clearTimeout(r.timer);
  const cnt = {}; Object.values(r.votes).forEach(t => { if (t !== 'skip') cnt[t] = (cnt[t] || 0) + 1; });
  const max = Math.max(0, ...Object.values(cnt)), top = Object.keys(cnt).filter(t => cnt[t] === max);
  if (top.length === 1) {
    const p = r.players.find(x => x.id === top[0]); p.alive = false;
    sys(r, `Город выбрал: ${p.name} выбывает. Его роль — ${RU[p.role]}.`);
  } else sys(r, 'Голоса разделились. Сегодня никто не выбывает.');
  if (!checkWin(r)) startNight(r);
}

function startGame(r) {
  const pool = [];
  Object.entries(r.settings.deck).forEach(([k, n]) => { for (let i = 0; i < n; i++) pool.push(k); });
  shuffle(pool);
  r.players.forEach((p, i) => { p.role = pool[i]; p.alive = true; p.revealed = false; });
  Object.assign(r, { known: false, winner: null, acts: {}, votes: {}, doctorSelfLast: false });
  sys(r, 'Роли розданы. Переверните свою карту.');
  go(r, 'ROLE_REVEAL', 0);
}

// ---------- сокеты ----------
function attach(socket, r, p) {
  p.sid = socket.id; p.online = true; socket.data = { rid: r.id, pid: p.id }; socket.join(r.id);
  socket.emit('chat:history', r.chat.filter(m => sees(p, m)));
  broadcast(r);
}
const ctx = socket => { const r = rooms.get(socket.data && socket.data.rid); return [r, r && r.players.find(p => p.id === socket.data.pid)]; };

io.on('connection', socket => {
  socket.on('room:create', ({ name, pid }, cb) => {
    name = clean(name, 16); pid = clean(pid, 40).replace(/[^\w-]/g, '');
    if (!name || !pid) return cb({ ok: false, message: 'Введите никнейм' });
    let id; do { id = crypto.randomBytes(4).toString('hex'); } while (rooms.has(id));
    const r = {
      id, hostId: pid, phase: 'LOBBY', deadline: null, winner: null, known: false, timer: null, chat: [], acts: {}, votes: {}, doctorSelfLast: false,
      settings: { deck: { civilian: 3, mafia: 1, don: 1, commissar: 1, doctor: 1, hooker: 1, hobo: 1 }, discussionTime: 90, nightTime: 30 },
      players: [{ id: pid, name, role: null, alive: true, revealed: false, online: false }]
    };
    rooms.set(id, r); attach(socket, r, r.players[0]); cb({ ok: true, roomId: id });
  });

  socket.on('room:join', ({ roomId, name, pid }, cb) => {
    const r = rooms.get(roomId); name = clean(name, 16); pid = clean(pid, 40).replace(/[^\w-]/g, '');
    if (!r) return cb({ ok: false, message: 'Комната не найдена' });
    let p = r.players.find(x => x.id === pid);
    if (!p) {
      if (r.phase !== 'LOBBY') return cb({ ok: false, message: 'Игра уже началась' });
      if (!name) return cb({ ok: false, message: 'Введите никнейм' });
      if (r.players.length >= 20) return cb({ ok: false, message: 'Комната заполнена' });
      if (r.players.some(x => x.name.toLowerCase() === name.toLowerCase())) return cb({ ok: false, message: 'Никнейм занят' });
      p = { id: pid, name, role: null, alive: true, revealed: false, online: false }; r.players.push(p);
    }
    attach(socket, r, p); cb({ ok: true });
  });

  socket.on('room:settings', ({ deck, discussionTime, nightTime }) => {
    const [r, p] = ctx(socket); if (!r || r.phase !== 'LOBBY' || p.id !== r.hostId) return;
    if (deck) ROLES.forEach(k => { r.settings.deck[k] = clamp(deck[k], 0, UNIQUE.includes(k) ? 1 : 15, r.settings.deck[k]); });
    r.settings.discussionTime = clamp(discussionTime, 30, 300, r.settings.discussionTime);
    r.settings.nightTime = clamp(nightTime, 15, 90, r.settings.nightTime);
    broadcast(r);
  });

  socket.on('game:start', () => {
    const [r, p] = ctx(socket); if (!r || r.phase !== 'LOBBY' || p.id !== r.hostId) return;
    const d = r.settings.deck, total = Object.values(d).reduce((a, b) => a + b, 0), black = d.mafia + d.don;
    if (r.players.length < 4) return socket.emit('err', 'Нужно минимум 4 игрока');
    if (total !== r.players.length) return socket.emit('err', `Ролей в колоде ${total}, игроков ${r.players.length}`);
    if (black < 1 || black * 2 >= total) return socket.emit('err', 'Мафии должно быть от 1 и меньше половины игроков');
    startGame(r);
  });

  socket.on('game:again', () => {
    const [r, p] = ctx(socket); if (!r || r.phase !== 'GAME_OVER' || p.id !== r.hostId) return;
    r.players.forEach(x => { x.role = null; x.alive = true; x.revealed = false; });
    r.winner = null; r.known = false; go(r, 'LOBBY', 0);
  });

  socket.on('card:reveal', () => {
    const [r, p] = ctx(socket); if (!r || r.phase !== 'ROLE_REVEAL') return;
    p.revealed = true;
    if (r.players.every(x => x.revealed)) {
      r.known = true; sys(r, 'Город засыпает. Мафия знакомится.');
      r.players.filter(isMaf).forEach(m => sys(r, `Ваша команда: ${r.players.filter(isMaf).map(x => `${x.name} (${RU[x.role]})`).join(', ')}.`, m.id));
      go(r, 'INTRO', 8, startNight);
    } else broadcast(r);
  });

  socket.on('chat:send', text => {
    const [r, p] = ctx(socket); text = clean(text, 300); if (!r || !text) return;
    if (r.phase === 'NIGHT') { if (p.alive && isMaf(p)) say(r, { scope: 'mafia', name: p.name, text }); return; }
    const open = r.phase === 'LOBBY' || r.phase === 'GAME_OVER' || r.phase === 'DAY';
    if (open && (p.alive || r.phase === 'LOBBY' || r.phase === 'GAME_OVER')) say(r, { scope: 'all', name: p.name, text });
  });

  socket.on('night:action', ({ kind, targetId }) => {
    const [r, p] = ctx(socket); if (!r || r.phase !== 'NIGHT' || !p.alive) return;
    const t = targetId === 'skip' ? 'skip' : (r.players.find(x => x.id === targetId && x.alive) || {}).id; if (!t) return;
    const ok = (isMaf(p) && kind === 'kill') || (kind === 'act' && ['don', 'hooker', 'doctor', 'commissar', 'hobo'].includes(p.role));
    if (!ok) return;
    if (p.role === 'doctor' && t === p.id && r.doctorSelfLast) return socket.emit('err', 'Себя нельзя лечить два раза подряд');
    (r.acts[p.id] = r.acts[p.id] || {})[kind] = t; broadcast(r);
  });

  socket.on('day:vote', ({ targetId }) => {
    const [r, p] = ctx(socket); if (!r || r.phase !== 'VOTING' || !p.alive) return;
    const t = targetId === 'skip' ? 'skip' : (r.players.find(x => x.id === targetId && x.alive) || {}).id; if (!t) return;
    r.votes[p.id] = t; broadcast(r);
    if (r.players.filter(x => x.alive).every(x => r.votes[x.id])) tally(r);
  });

  socket.on('disconnect', () => {
    const [r, p] = ctx(socket); if (!r || p.sid !== socket.id) return;
    p.online = false;
    if (r.phase === 'LOBBY') {
      r.players = r.players.filter(x => x !== p);
      if (r.hostId === p.id && r.players.length) { r.hostId = r.players[0].id; }
    }
    if (!r.players.some(x => x.online)) {
      clearTimeout(r.cleanup);
      r.cleanup = setTimeout(() => { if (!r.players.some(x => x.online)) { clearTimeout(r.timer); rooms.delete(r.id); } }, r.phase === 'LOBBY' ? 1000 : 10 * 60 * 1000);
    }
    broadcast(r);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Мафия: http://localhost:${PORT}`));
