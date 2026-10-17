const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { randomUUID } = require('crypto');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 20000,
  pingTimeout: 60000
});

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

const PHASES = {
  LOBBY: 'LOBBY',
  ROLE_REVEAL: 'ROLE_REVEAL',
  FIRST_NIGHT_INTRO: 'FIRST_NIGHT_INTRO',
  NIGHT: 'NIGHT',
  MORNING_LAST_WORDS: 'MORNING_LAST_WORDS',
  DAY: 'DAY',
  VOTING: 'VOTING',
  CONFIRM_VOTE: 'CONFIRM_VOTE',
  KAMIKAZE_REVENGE: 'KAMIKAZE_REVENGE',
  GAME_OVER: 'GAME_OVER'
};

const ROLE_FACTIONS = {
  civilian: 'RED', lucky: 'RED', commissar: 'RED', doctor: 'RED', hooker: 'RED',
  hobo: 'RED', journalist: 'RED',
  mafia: 'BLACK', don: 'BLACK', instigator: 'BLACK',
  kamikaze: 'BLACK', // настраивается хостом
  suicider: 'NEUTRAL', necromancer: 'NEUTRAL', puppeteer: 'NEUTRAL',
  mirror: 'RED',
  cultist: 'CULT'
};

const ACTIVE_ROLES = new Set([
  'commissar', 'doctor', 'hooker', 'hobo', 'journalist', 'mafia', 'don',
  'instigator', 'necromancer', 'cultist', 'puppeteer', 'mirror'
]);

const ROLE_NAMES_RU = {
  civilian: 'Мирный житель', lucky: 'Счастливчик', commissar: 'Комиссар', doctor: 'Доктор',
  hooker: 'Любовница', hobo: 'Бомж', journalist: 'Журналист', kamikaze: 'Камикадзе',
  mafia: 'Мафия', don: 'Дон Мафии', instigator: 'Подстрекатель', suicider: 'Самоубийца',
  necromancer: 'Некромант', cultist: 'Сектант', puppeteer: 'Кукловод', mirror: 'Зеркало'
};
const roleRu = (role) => ROLE_NAMES_RU[role] || role;

// Анонимные фразы для чата, когда роль сделала ночной ход (без имён игроков)
const NIGHT_PHRASES = {
  commissar: '🕵️ Комиссар вышел на ночное расследование.',
  doctor: '⚕️ Доктор взял чемоданчик и отправился на вызов.',
  hooker: '💋 Любовница вышла на ночной промысел.',
  hobo: '🍾 Бомж пошёл за бутылкой.',
  journalist: '📰 Журналист засел за новую статью.',
  mafia: '🦹‍♂️ Мафия сделала свой выбор.',
  don: '🎩 Дон отдал тайное распоряжение.',
  instigator: '🐍 Подстрекатель плетёт интриги.',
  necromancer: '🔮 Некромант зашептал над могилами.',
  cultist: '🕯️ Проповедник отправился на тайную проповедь.',
  puppeteer: '🎭 Кукловод дёрнул за ниточки.',
  mirror: '🪞 Зеркало выбрало свою тень.'
};

// ---------- Утилиты ----------

// ----- Аккаунты (хранятся в data/users.json) -----
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
let db = { users: [] };
try { db = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch (e) { /* файла ещё нет */ }
if (!Array.isArray(db.users)) db.users = [];

function saveUsers() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = USERS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, USERS_FILE);
  } catch (e) {
    console.error('Не удалось сохранить аккаунты:', e.message);
  }
}
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const hashPassword = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const findUserByName = (name) => db.users.find(u => u.nameLower === String(name).toLowerCase());
const findUserByToken = (token) => (token ? db.users.find(u => u.tokens.includes(sha(token))) : null);
function issueToken(user) {
  const token = crypto.randomBytes(32).toString('hex');
  user.tokens.push(sha(token));
  if (user.tokens.length > 10) user.tokens.shift();
  saveUsers();
  return token;
}
function rateOk(socket) {
  const now = Date.now();
  const log = (socket.data.authLog = (socket.data.authLog || []).filter(t => now - t < 60000));
  if (log.length >= 10) return false;
  log.push(now);
  return true;
}

// Личность игрока: аккаунт (u_...) или гость (g_...). Не зависит от socket.id,
// поэтому после сворачивания/перезагрузки игрок возвращается на своё место.
io.use((socket, next) => {
  const a = socket.handshake.auth || {};
  const user = findUserByToken(typeof a.token === 'string' ? a.token : '');
  if (user) {
    socket.data.playerId = user.id;
    socket.data.user = user;
  } else {
    const g = String(a.guestId || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64) || randomUUID();
    socket.data.playerId = 'g_' + g;
    socket.data.user = null;
  }
  next();
});

// ----- Сессии и комнаты -----
const playerRooms = new Map(); // playerId -> roomId

function roomOfPlayer(pid) {
  const id = playerRooms.get(pid);
  const room = id ? rooms.get(id) : null;
  return room && room.players.some(p => p.id === pid) ? room : null;
}

function destroyRoom(room) {
  clearTimeout(room.phaseTimer);
  clearTimeout(room.cleanupTimer);
  room.players.forEach(p => {
    clearTimeout(p.dcTimer);
    if (playerRooms.get(p.id) === room.roomId) playerRooms.delete(p.id);
  });
  rooms.delete(room.roomId);
}

// Если в комнате никого нет онлайн 10 минут — удаляем
function scheduleCleanup(room) {
  clearTimeout(room.cleanupTimer);
  if (room.players.some(p => p.connected)) return;
  room.cleanupTimer = setTimeout(() => destroyRoom(room), 10 * 60 * 1000);
}

function removeFromLobby(room, pid) {
  const idx = room.players.findIndex(p => p.id === pid);
  if (idx === -1) return;
  clearTimeout(room.players[idx].dcTimer);
  room.players.splice(idx, 1);
  playerRooms.delete(pid);
  if (room.players.length === 0) return destroyRoom(room);
  if (room.hostId === pid) room.hostId = (room.players.find(p => p.connected) || room.players[0]).id;
  emitRoom(room);
}

function leaveRoom(pid) {
  const room = roomOfPlayer(pid);
  if (!room) return;
  io.in(pid).socketsLeave(room.roomId);
  playerRooms.delete(pid);
  const player = room.players.find(p => p.id === pid);
  if (!player) return;
  clearTimeout(player.dcTimer);
  if (room.status === PHASES.LOBBY) {
    removeFromLobby(room, pid);
  } else {
    player.connected = false;
    player.left = true;
    emitRoom(room);
    scheduleCleanup(room);
  }
}

// Журналы для восстановления после возвращения в игру
function emitChat(roomId, msg) {
  const room = rooms.get(roomId);
  if (room) {
    room.chatLog.push(msg);
    if (room.chatLog.length > 200) room.chatLog.shift();
  }
  io.to(roomId).emit('chat:global:message', msg);
}

function emitPhase(room, payload) {
  room.phaseInfo = { ...payload, endsAt: Date.now() + (payload.timeLeft || 0) * 1000 };
  io.to(room.roomId).emit('game:phase_change', payload);
}

function notify(room, pid, text) {
  const p = room.players.find(x => x.id === pid);
  if (p) {
    p.alerts.unshift({ id: randomUUID(), text });
    if (p.alerts.length > 50) p.alerts.pop();
  }
  io.to(pid).emit('personal:alert', text);
}

function sendState(socket) {
  const pid = socket.data.playerId;
  socket.emit('auth:state', { playerId: pid, user: socket.data.user ? { name: socket.data.user.name } : null });
  const room = roomOfPlayer(pid);
  const player = room && room.players.find(p => p.id === pid);
  if (!room || !player) return socket.emit('session:none');

  const black = player.faction === 'BLACK';
  const phase = room.phaseInfo;
  socket.emit('session:restore', {
    room: publicRoom(room, pid),
    myRole: player.role,
    revealed: player.hasRevealedCard,
    acted: !!room.nightDone[pid],
    myVote: room.status === PHASES.VOTING ? (room.dayVotes[pid] || null)
      : room.status === PHASES.CONFIRM_VOTE ? (room.confirmVotes[pid] || null) : null,
    phase: phase ? {
      status: phase.status, round: phase.round, message: phase.message,
      timeLeft: Math.max(0, Math.ceil((phase.endsAt - Date.now()) / 1000))
    } : null,
    chat: room.chatLog,
    mafiaChat: black ? room.mafiaLog : [],
    alerts: player.alerts,
    cult: player.isAlive && player.isCultMember
      ? room.players.filter(p => p.isAlive && p.isCultMember).map(p => p.name) : [],
    mafiaTeam: black
      ? room.players.filter(p => p.faction === 'BLACK').map(p => ({ id: p.id, name: p.name, role: p.role })) : [],
    gameOver: room.status === PHASES.GAME_OVER ? { winner: room.winner } : null
  });
}

function makeRoomId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id;
  do {
    id = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (rooms.has(id));
  return id;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function newPlayer(id, name, isHost) {
  return {
    id,
    name: String(name || 'Игрок').trim().slice(0, 20) || 'Игрок',
    role: null,
    originalRole: null,
    faction: null,
    isAlive: true,
    isHost,
    connected: true,
    hasRevealedCard: false,
    isCultMember: false,
    hasUsedInstigator: false,
    mirrorDonorId: null,
    lastDoctorTarget: null,
    awaitingLastWords: false,
    alerts: [],
    dcTimer: null,
    left: false
  };
}

// Комната БЕЗ секретов (и без объекта таймера, который нельзя сериализовать).
// Чужие роли видны только мертвым игрокам и после конца игры.
function publicRoom(room, viewerId) {
  const gameOver = room.status === PHASES.GAME_OVER;
  return {
    roomId: room.roomId,
    hostId: room.hostId,
    status: room.status,
    round: room.round,
    settings: room.settings,
    kamikazeActorId: room.kamikazeActorId,
    accusedId: room.accusedId,
    winner: room.winner,
    players: room.players.map(p => {
      const reveal = p.id === viewerId || !p.isAlive || gameOver;
      return {
        id: p.id,
        name: p.name,
        isAlive: p.isAlive,
        isHost: p.id === room.hostId,
        connected: p.connected,
        hasRevealedCard: p.hasRevealedCard,
        role: reveal ? p.role : null,
        originalRole: reveal ? p.originalRole : null,
        faction: reveal ? p.faction : null,
        isCultMember: p.id === viewerId ? p.isCultMember : false
      };
    })
  };
}

function emitRoom(room) {
  room.players.forEach(p => {
    if (p.connected) io.to(p.id).emit('room:update', publicRoom(room, p.id));
  });
}

function sendSystemChat(roomId, text) {
  emitChat(roomId, {
    id: randomUUID(), senderName: 'Ведущий', message: text, type: 'system'
  });
}

function setTimer(room, fn, ms) {
  clearTimeout(room.phaseTimer);
  room.phaseTimer = setTimeout(fn, ms);
}

function resetRoundState(room) {
  room.nightActions = {};
  room.nightDone = {};
  room.nightAnnounced = {};
  room.dayVotes = {};
  room.accusedId = null;
  room.confirmVotes = {};
  room.kamikazeActorId = null;
  room.chatLog = [];
  room.mafiaLog = [];
  room.phaseInfo = null;
}

// ---------- Сокеты ----------
io.on('connection', (socket) => {
  const myPid = socket.data.playerId;
  socket.join(myPid);

  // Игрок вернулся (развернул окно / перезагрузил страницу): возвращаем в его комнату
  const returning = roomOfPlayer(myPid);
  if (returning) {
    const pl = returning.players.find(p => p.id === myPid);
    socket.join(returning.roomId);
    clearTimeout(pl.dcTimer);
    clearTimeout(returning.cleanupTimer);
    pl.connected = true;
    emitRoom(returning);
  }

  // Клиент сообщает, что готов принять состояние (после регистрации обработчиков)
  socket.on('client:ready', () => sendState(socket));

  socket.on('auth:register', ({ name, password } = {}, cb) => {
    if (typeof cb !== 'function') return;
    if (!rateOk(socket)) return cb({ success: false, message: 'Слишком много попыток. Подождите минуту.' });
    const n = String(name || '').trim();
    if (!/^[\p{L}\p{N}_\- .]{2,20}$/u.test(n)) return cb({ success: false, message: 'Ник: 2–20 символов (буквы, цифры, _ - .)' });
    if (typeof password !== 'string' || password.length < 6 || password.length > 100) {
      return cb({ success: false, message: 'Пароль должен быть не короче 6 символов' });
    }
    if (findUserByName(n)) return cb({ success: false, message: 'Такой ник уже занят' });
    const salt = crypto.randomBytes(16).toString('hex');
    const user = { id: 'u_' + randomUUID(), name: n, nameLower: n.toLowerCase(), salt, hash: hashPassword(password, salt), tokens: [] };
    db.users.push(user);
    cb({ success: true, token: issueToken(user), name: n });
  });

  socket.on('auth:login', ({ name, password } = {}, cb) => {
    if (typeof cb !== 'function') return;
    if (!rateOk(socket)) return cb({ success: false, message: 'Слишком много попыток. Подождите минуту.' });
    const user = findUserByName(String(name || '').trim());
    if (!user || typeof password !== 'string') return cb({ success: false, message: 'Неверный ник или пароль' });
    const a = Buffer.from(hashPassword(password, user.salt), 'hex');
    const b = Buffer.from(user.hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return cb({ success: false, message: 'Неверный ник или пароль' });
    cb({ success: true, token: issueToken(user), name: user.name });
  });

  socket.on('auth:logout', ({ token } = {}, cb) => {
    const user = findUserByToken(typeof token === 'string' ? token : '');
    if (user) {
      user.tokens = user.tokens.filter(h => h !== sha(token));
      saveUsers();
    }
    if (typeof cb === 'function') cb();
  });

  socket.on('room:leave', () => {
    leaveRoom(socket.data.playerId);
    io.to(socket.data.playerId).emit('session:none');
  });
  socket.on('room:create', ({ playerName } = {}, callback) => {
    if (typeof callback !== 'function') return;
    const pid = socket.data.playerId;
    leaveRoom(pid);
    const name = socket.data.user ? socket.data.user.name : playerName;
    const roomId = makeRoomId();
    const room = {
      roomId,
      hostId: pid,
      status: PHASES.LOBBY,
      round: 0,
      settings: {
        deck: {
          civilian: 1, lucky: 1, commissar: 1, doctor: 1, hooker: 0, hobo: 0,
          journalist: 1, kamikaze: 1, mafia: 1, don: 1, instigator: 0,
          suicider: 1, necromancer: 0, cultist: 0, puppeteer: 0, mirror: 0
        },
        kamikazeFaction: 'BLACK',
        discussionTime: 60,
        nightActionTime: 35,
        votingTime: 30,
        confirmTime: 15
      },
      players: [newPlayer(pid, name, true)],
      phaseTimer: null,
      cleanupTimer: null,
      banned: new Set(),
      winner: null
    };
    resetRoundState(room);
    rooms.set(roomId, room);
    playerRooms.set(pid, roomId);
    io.in(pid).socketsJoin(roomId);
    callback({ success: true, roomId, room: publicRoom(room, pid) });
  });

  socket.on('room:join', ({ roomId, playerName } = {}, callback) => {
    if (typeof callback !== 'function') return;
    const pid = socket.data.playerId;
    const cleanId = String(roomId || '').trim().toUpperCase();
    const room = rooms.get(cleanId);
    if (!room) return callback({ success: false, message: 'Комната не найдена' });

    const isMember = room.players.some(p => p.id === pid);
    if (!isMember && room.banned.has(pid)) return callback({ success: false, message: 'Ведущий исключил вас из этой комнаты' });
    if (!isMember) {
      if (room.status !== PHASES.LOBBY) return callback({ success: false, message: 'Игра уже началась' });
      if (room.players.length >= 30) return callback({ success: false, message: 'Комната заполнена' });
      leaveRoom(pid);
      const name = socket.data.user ? socket.data.user.name : playerName;
      room.players.push(newPlayer(pid, name, false));
      playerRooms.set(pid, cleanId);
    }
    io.in(pid).socketsJoin(cleanId);
    emitRoom(room);
    callback({ success: true, roomId: cleanId, room: publicRoom(room, pid) });
  });

  // Ведущий исключает игрока из лобби до начала игры
  socket.on('room:kick', ({ roomId, targetId } = {}) => {
    const room = rooms.get(roomId);
    if (!room || room.hostId !== socket.data.playerId || room.status !== PHASES.LOBBY) return;
    if (targetId === room.hostId || !room.players.some(p => p.id === targetId)) return;
    room.banned.add(targetId);
    io.to(targetId).emit('room:kicked', { message: 'Ведущий исключил вас из комнаты.' });
    io.in(targetId).socketsLeave(room.roomId);
    removeFromLobby(room, targetId);
  });

  socket.on('room:update_settings', ({ roomId, deck, kamikazeFaction, times } = {}) => {
    const room = rooms.get(roomId);
    if (!room || room.hostId !== socket.data.playerId || room.status !== PHASES.LOBBY) return;
    if (deck && typeof deck === 'object') {
      const clean = {};
      for (const key of Object.keys(ROLE_FACTIONS)) {
        clean[key] = Math.max(0, Math.min(10, parseInt(deck[key], 10) || 0));
      }
      room.settings.deck = clean;
    }
    if (['RED', 'BLACK'].includes(kamikazeFaction)) room.settings.kamikazeFaction = kamikazeFaction;
    // Управление временем фаз (10–300 секунд)
    if (times && typeof times === 'object') {
      ['discussionTime', 'nightActionTime', 'votingTime', 'confirmTime'].forEach(key => {
        const v = parseInt(times[key], 10);
        if (!isNaN(v)) room.settings[key] = Math.max(10, Math.min(300, v));
      });
    }
    emitRoom(room);
  });

  socket.on('game:start', ({ roomId } = {}) => {
    const room = rooms.get(roomId);
    if (!room || room.hostId !== socket.data.playerId || room.status !== PHASES.LOBBY) return;

    const totalCards = Object.values(room.settings.deck).reduce((a, b) => a + b, 0);
    if (room.players.length < 3) {
      return socket.emit('game:error', 'Для игры нужно минимум 3 игрока!');
    }
    if (totalCards !== room.players.length) {
      return socket.emit('game:error', `Сумма ролей в колоде (${totalCards}) должна совпадать с числом игроков (${room.players.length})!`);
    }

    let rolesPool = [];
    for (const [role, count] of Object.entries(room.settings.deck)) {
      for (let i = 0; i < count; i++) rolesPool.push(role);
    }
    rolesPool = shuffle(rolesPool);

    room.round = 1;
    room.winner = null;
    resetRoundState(room);
    room.players.forEach((player, idx) => {
      const role = rolesPool[idx];
      player.role = role;
      player.originalRole = role;
      player.faction = role === 'kamikaze' ? room.settings.kamikazeFaction : ROLE_FACTIONS[role];
      player.isAlive = true;
      player.hasRevealedCard = false;
      player.isCultMember = role === 'cultist';
      player.hasUsedInstigator = false;
      player.mirrorDonorId = null;
      player.lastDoctorTarget = null;
      player.awaitingLastWords = false;
      player.alerts = [];
    });

    room.status = PHASES.ROLE_REVEAL;
    room.players.forEach(p => io.to(p.id).emit('game:started', publicRoom(room, p.id)));
    sendSystemChat(roomId, '🃏 Партия началась! Игроки вскрывают свои карточки ролей.');
  });

  socket.on('game:restart', ({ roomId } = {}) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== PHASES.GAME_OVER) return;
    const oldHost = room.players.find(p => p.id === room.hostId);
    if (room.hostId !== socket.data.playerId && oldHost && oldHost.connected) return;
    room.hostId = socket.data.playerId;
    clearTimeout(room.phaseTimer);
    room.players = room.players.filter(p => p.connected);
    room.players.forEach(p => {
      Object.assign(p, newPlayer(p.id, p.name, p.id === room.hostId));
    });
    room.status = PHASES.LOBBY;
    room.round = 0;
    room.winner = null;
    resetRoundState(room);
    io.to(roomId).emit('game:restarted');
    emitRoom(room);
  });

  socket.on('player:reveal_card', ({ roomId } = {}) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== PHASES.ROLE_REVEAL) return;

    const player = room.players.find(p => p.id === socket.data.playerId);
    if (!player) return;
    player.hasRevealedCard = true;
    emitRoom(room);

    if (room.players.filter(p => p.connected).every(p => p.hasRevealedCard)) {
      room.status = PHASES.FIRST_NIGHT_INTRO;

      const mafiaTeam = room.players
        .filter(p => p.faction === 'BLACK')
        .map(p => ({ id: p.id, name: p.name, role: p.role }));
      room.players.forEach(p => {
        if (p.faction === 'BLACK') io.to(p.id).emit('mafia:acquaintance', mafiaTeam);
      });

      emitRoom(room);
      emitPhase(room, {
        status: room.status,
        round: room.round,
        timeLeft: 8,
        message: 'Город засыпает... Мафия знакомится друг с другом.'
      });
      setTimer(room, () => startNightPhase(roomId), 8000);
    }
  });

  socket.on('chat:global', ({ roomId, message } = {}) => {
    const room = rooms.get(roomId);
    if (!room || typeof message !== 'string' || !message.trim()) return;
    if (![PHASES.LOBBY, PHASES.DAY, PHASES.VOTING, PHASES.CONFIRM_VOTE].includes(room.status)) return;

    const sender = room.players.find(p => p.id === socket.data.playerId);
    if (!sender || (!sender.isAlive && room.status !== PHASES.LOBBY)) return;

    emitChat(roomId, {
      id: randomUUID(), senderName: sender.name, message: message.trim().slice(0, 300), type: 'normal'
    });
  });

  socket.on('chat:mafia', ({ roomId, message } = {}) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== PHASES.NIGHT || typeof message !== 'string' || !message.trim()) return;

    const sender = room.players.find(p => p.id === socket.data.playerId);
    if (sender && sender.faction === 'BLACK' && sender.isAlive) {
      const msg = { senderName: sender.name, role: sender.role, message: message.trim().slice(0, 300) };
      room.mafiaLog.push(msg);
      if (room.mafiaLog.length > 100) room.mafiaLog.shift();
      room.players.forEach(p => {
        if (p.faction === 'BLACK') io.to(p.id).emit('chat:mafia:message', msg);
      });
    }
  });

  socket.on('player:last_words', ({ roomId, message } = {}) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== PHASES.MORNING_LAST_WORDS) return;

    const player = room.players.find(p => p.id === socket.data.playerId);
    if (!player || !player.awaitingLastWords) return;

    player.awaitingLastWords = false;
    if (typeof message === 'string' && message.trim()) {
      emitChat(roomId, {
        id: randomUUID(), senderName: player.name, message: message.trim().slice(0, 220), type: 'last_words'
      });
    }

    if (!room.players.some(p => p.awaitingLastWords)) {
      proceedAfterMorning(roomId);
    }
  });

  socket.on('night:action', ({ roomId, targetId, secondTargetId } = {}) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== PHASES.NIGHT) return;

    const player = room.players.find(p => p.id === socket.data.playerId);
    if (!player || !player.isAlive || !ACTIVE_ROLES.has(player.role)) return;

    const target = room.players.find(p => p.id === targetId);
    if (!target) return;
    // Некромант выбирает мертвого, остальные — живых
    if (player.role === 'necromancer' ? target.isAlive : !target.isAlive) return;

    let second = null;
    if (secondTargetId) {
      const s = room.players.find(p => p.id === secondTargetId && p.isAlive);
      if (s) second = s.id;
    }

    if (player.role === 'mirror') {
      if (room.round !== 1 || target.id === player.id) return;
      player.mirrorDonorId = target.id;
    }

    room.nightActions[player.id] = {
      actorId: player.id,
      role: player.role,
      targetId: target.id,
      secondTargetId: second
    };

    socket.emit('night:action_confirmed', { role: player.role, targetId, secondTargetId });
    markNightDone(room, player, true);
  });

  // Игрок без способности (или пропускающий ход) сообщает, что закончил
  socket.on('night:ready', ({ roomId } = {}) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== PHASES.NIGHT) return;
    const player = room.players.find(p => p.id === socket.data.playerId);
    if (!player || !player.isAlive) return;
    socket.emit('night:action_confirmed', { role: player.role });
    markNightDone(room, player);
  });

  socket.on('day:vote', ({ roomId, targetId } = {}) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== PHASES.VOTING) return;

    const voter = room.players.find(p => p.id === socket.data.playerId);
    const target = room.players.find(p => p.id === targetId && p.isAlive);
    if (!voter || !voter.isAlive || !target) return;

    const prev = room.dayVotes[voter.id];
    if (prev === target.id) return;
    room.dayVotes[voter.id] = target.id;
    io.to(roomId).emit('day:vote_update', { voterName: voter.name, targetId: target.id });
    sendSystemChat(roomId, `🗳️ ${voter.name} ${prev ? 'изменил голос и голосует' : 'голосует'} против ${target.name}.`);
  });

  // Второе голосование: вешаем обвиняемого или нет
  socket.on('day:confirm', ({ roomId, vote } = {}) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== PHASES.CONFIRM_VOTE) return;
    const voter = room.players.find(p => p.id === socket.data.playerId);
    if (!voter || !voter.isAlive || voter.id === room.accusedId) return;

    const val = vote === 'yes' ? 'yes' : 'no';
    const prev = room.confirmVotes[voter.id];
    if (prev === val) return;
    room.confirmVotes[voter.id] = val;
    sendSystemChat(roomId, `${val === 'yes' ? '👍' : '👎'} ${voter.name} ${prev ? 'изменил голос:' : 'голосует'} ${val === 'yes' ? 'ЗА казнь' : 'ПРОТИВ казни'}.`);

    const eligible = room.players.filter(p => p.isAlive && p.connected && p.id !== room.accusedId);
    if (eligible.every(p => room.confirmVotes[p.id])) {
      setTimer(room, () => resolveConfirm(roomId), 1500);
    }
  });

  socket.on('kamikaze:shoot', ({ roomId, targetId } = {}) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== PHASES.KAMIKAZE_REVENGE) return;
    if (socket.data.playerId !== room.kamikazeActorId) return;
    if (!room.players.some(p => p.id === targetId && p.isAlive)) return;
    executeKamikazeRevenge(roomId, targetId);
  });

  socket.on('disconnect', () => {
    const pid = socket.data.playerId;
    const still = io.sockets.adapter.rooms.get(pid);
    if (still && still.size > 0) return; // у игрока открыта другая вкладка
    const room = roomOfPlayer(pid);
    if (!room) return;
    const player = room.players.find(p => p.id === pid);
    if (!player) return;

    // Игрока НЕ выкидываем: в партии место сохраняется, в лобби даётся 3 минуты на возвращение
    player.connected = false;
    if (room.status === PHASES.LOBBY) {
      clearTimeout(player.dcTimer);
      player.dcTimer = setTimeout(() => {
        const r = rooms.get(room.roomId);
        const pl = r && r.players.find(p => p.id === pid);
        if (r && r.status === PHASES.LOBBY && pl && !pl.connected) removeFromLobby(r, pid);
      }, 3 * 60 * 1000);
    }
    emitRoom(room);
    scheduleCleanup(room);
  });
});

// ---------- Фазы ----------

// Публично сообщаем, кто уже закончил ночные дела (без раскрытия цели и роли).
// Если закончили все живые — ночь завершается досрочно.
function markNightDone(room, player, announce = false) {
  if (room.nightDone[player.id]) return;
  room.nightDone[player.id] = true;
  // Одно анонимное сообщение на роль за ночь (без имён)
  const phrase = NIGHT_PHRASES[player.role];
  if (announce && phrase && !room.nightAnnounced[player.role]) {
    room.nightAnnounced[player.role] = true;
    sendSystemChat(room.roomId, phrase);
  }

  const pending = room.players.filter(p => p.isAlive && p.connected && !room.nightDone[p.id]);
  if (pending.length === 0) {
    sendSystemChat(room.roomId, '🌅 Все готовы — ночь заканчивается досрочно.');
    setTimer(room, () => resolveNight(room.roomId), 1500);
  }
}

function startNightPhase(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (checkWinConditions(roomId)) return;

  room.status = PHASES.NIGHT;
  room.nightActions = {};
  room.nightDone = {};
  room.nightAnnounced = {};

  emitRoom(room);
  emitPhase(room, {
    status: PHASES.NIGHT,
    round: room.round,
    timeLeft: room.settings.nightActionTime,
    message: `Ночь ${room.round}. Город спит, активные роли делают свой выбор.`
  });

  setTimer(room, () => resolveNight(roomId), room.settings.nightActionTime * 1000);
}

function resolveNight(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.status !== PHASES.NIGHT) return;
  clearTimeout(room.phaseTimer);

  // копии действий, чтобы Кукловод не портил оригинал
  const actions = {};
  Object.entries(room.nightActions).forEach(([k, v]) => { actions[k] = { ...v }; });

  const visits = {};
  const registerVisit = (targetId, visitorName) => {
    if (!targetId) return;
    (visits[targetId] = visits[targetId] || []).push(visitorName);
  };
  const byId = (id) => room.players.find(p => p.id === id);

  // 1. Кукловод перенаправляет ход марионетки (до блокировок, чтобы перенаправление работало на всех)
  Object.values(actions).forEach(act => {
    if (act.role !== 'puppeteer') return;
    const puppet = actions[act.targetId];
    if (puppet && act.secondTargetId && puppet.role !== 'necromancer' && puppet.role !== 'mirror') {
      puppet.targetId = act.secondTargetId;
      notify(room, act.targetId, '🎭 Кукловод перехватил управление вашими руками этой ночью!');
    }
  });

  // 2. Блокировка Любовницей
  const blockedPlayerIds = new Set();
  Object.values(actions).forEach(act => {
    if (act.role === 'hooker' && act.targetId) {
      blockedPlayerIds.add(act.targetId);
      const hooker = byId(act.actorId);
      if (hooker) registerVisit(act.targetId, hooker.name);
      notify(room, act.targetId, '💋 Этой ночью вас отвлекли — ваша способность не сработала.');
    }
  });

  // 3. Некромант
  let necromancerKillTarget = null;
  let necromancerHealTarget = null;
  Object.values(actions).forEach(act => {
    if (act.role !== 'necromancer' || blockedPlayerIds.has(act.actorId)) return;
    const deadPlayer = room.players.find(p => p.id === act.targetId && !p.isAlive);
    const livingTarget = room.players.find(p => p.id === act.secondTargetId && p.isAlive);
    const necro = byId(act.actorId);
    if (!deadPlayer || !livingTarget || !necro) return;

    registerVisit(livingTarget.id, necro.name);
    if (['mafia', 'don', 'kamikaze'].includes(deadPlayer.role)) {
      necromancerKillTarget = livingTarget.id;
    } else if (deadPlayer.role === 'doctor') {
      necromancerHealTarget = livingTarget.id;
    } else if (deadPlayer.role === 'hooker') {
      blockedPlayerIds.add(livingTarget.id);
    } else if (deadPlayer.role === 'commissar') {
      const isBlack = livingTarget.faction === 'BLACK';
      notify(room, necro.id, `💀 Дух Шерифа проверил ${livingTarget.name}: ${isBlack ? 'МАФИЯ' : 'НЕ МАФИЯ'}`);
    }
  });

  // 4. Подстрекатель
  let framedPlayerId = null;
  Object.values(actions).forEach(act => {
    if (act.role !== 'instigator' || blockedPlayerIds.has(act.actorId)) return;
    const inst = byId(act.actorId);
    if (inst && !inst.hasUsedInstigator && act.targetId) {
      framedPlayerId = act.targetId;
      inst.hasUsedInstigator = true;
      registerVisit(act.targetId, inst.name);
    }
  });

  // 5. Выстрел Мафии и Дона
  const mafiaVotes = {};
  Object.values(actions).forEach(act => {
    if (['mafia', 'don'].includes(act.role) && !blockedPlayerIds.has(act.actorId) && act.targetId) {
      mafiaVotes[act.targetId] = (mafiaVotes[act.targetId] || 0) + 1;
      const shooter = byId(act.actorId);
      if (shooter) registerVisit(act.targetId, shooter.name);
    }
  });
  let mafiaKillTarget = null;
  let best = 0;
  Object.entries(mafiaVotes).forEach(([id, n]) => {
    if (n > best) { best = n; mafiaKillTarget = id; }
  });

  // 6. Доктор
  const healedTargets = new Set();
  if (necromancerHealTarget) healedTargets.add(necromancerHealTarget);
  room.players.forEach(p => {
    if (p.role === 'doctor' && p.isAlive && !actions[p.id]) p.lastDoctorTarget = null;
  });
  Object.values(actions).forEach(act => {
    if (act.role !== 'doctor' || blockedPlayerIds.has(act.actorId) || !act.targetId) return;
    const doc = byId(act.actorId);
    if (!doc) return;
    if (doc.lastDoctorTarget !== act.targetId) {
      healedTargets.add(act.targetId);
      doc.lastDoctorTarget = act.targetId;
      registerVisit(act.targetId, doc.name);
    } else {
      doc.lastDoctorTarget = null;
      notify(room, doc.id, '⚕️ Нельзя лечить одного и того же игрока две ночи подряд — лечение не сработало.');
    }
  });

  // 7. Смерти + «Счастливчик»
  const killedIds = new Set();
  let luckySurvivedMessage = null;

  if (mafiaKillTarget && !healedTargets.has(mafiaKillTarget)) {
    const victim = byId(mafiaKillTarget);
    if (victim && victim.isAlive) {
      if (victim.role === 'lucky' && Math.random() < 0.5) {
        luckySurvivedMessage = '🍀 Ночью мафия стреляла в Счастливчика, но пуля прошла по касательной — он чудом выжил!';
        notify(room, victim.id, '🍀 В вас стреляла мафия, но ваша пассивная Удача спасла вам жизнь!');
      } else {
        killedIds.add(victim.id);
      }
    }
  }
  if (necromancerKillTarget && !healedTargets.has(necromancerKillTarget)) {
    killedIds.add(necromancerKillTarget);
  }

  // 8. Вербовка Сектанта
  Object.values(actions).forEach(act => {
    if (act.role !== 'cultist' || blockedPlayerIds.has(act.actorId) || killedIds.has(act.actorId) || !act.targetId) return;
    const target = byId(act.targetId);
    const leader = byId(act.actorId);
    if (target && target.isAlive && !killedIds.has(target.id) && !target.isCultMember) {
      target.isCultMember = true;
      if (leader) registerVisit(target.id, leader.name);
      notify(room, target.id, '🕯️ Проповедник обратил вас в тайный культ Сектантов!');
    }
  });

  // 9a. Регистрация визитов Комиссара/Журналиста (чтобы Бомж видел их независимо от порядка)
  Object.values(actions).forEach(act => {
    if (blockedPlayerIds.has(act.actorId)) return;
    const actor = byId(act.actorId);
    if (!actor) return;
    if (act.role === 'commissar' && act.targetId) registerVisit(act.targetId, actor.name);
    if (act.role === 'journalist' && act.targetId && act.secondTargetId) {
      registerVisit(act.targetId, actor.name);
      registerVisit(act.secondTargetId, actor.name);
    }
  });

  // 9b. Проверки
  Object.values(actions).forEach(act => {
    const actor = byId(act.actorId);
    if (!actor || blockedPlayerIds.has(actor.id)) return;

    if (act.role === 'commissar' && act.targetId) {
      const target = byId(act.targetId);
      if (target) {
        const isBlack = target.faction === 'BLACK' || target.id === framedPlayerId;
        notify(room, actor.id, `🕵️ Проверка Комиссара: ${target.name} — ${isBlack ? 'ЧЕРНЫЙ (Мафия / Подставлен)' : 'КРАСНЫЙ (Мирный)'}`);
      }
    }

    if (act.role === 'don' && act.secondTargetId) {
      const t = byId(act.secondTargetId);
      if (t) {
        notify(room, actor.id, `🎩 Проверка Дона: ${t.name} — ${t.role === 'commissar' ? 'КОМИССАР!' : 'Не Комиссар'}`);
      }
    }

    if (act.role === 'journalist' && act.targetId && act.secondTargetId) {
      const p1 = byId(act.targetId);
      const p2 = byId(act.secondTargetId);
      if (p1 && p2) {
        const same = getEffectiveFactionForJournalist(p1, framedPlayerId) === getEffectiveFactionForJournalist(p2, framedPlayerId);
        notify(room, actor.id, `📰 Расследование Журналиста: ${p1.name} и ${p2.name} играют за ${same ? 'ОДНУ фракцию' : 'РАЗНЫЕ фракции'}!`);
      }
    }
  });

  // 9c. Бомж — после того как все визиты зарегистрированы
  Object.values(actions).forEach(act => {
    if (act.role !== 'hobo' || blockedPlayerIds.has(act.actorId) || !act.targetId) return;
    const actor = byId(act.actorId);
    const target = byId(act.targetId);
    if (!actor || !target) return;
    const guests = (visits[target.id] || []).filter(name => name !== actor.name);
    notify(room, actor.id, `🍾 Бомж проследил за ${target.name}. Гости этой ночью: ${guests.length ? guests.join(', ') : 'никто не приходил'}.`);
  });

  // Применяем смерти
  const deadNames = [];
  killedIds.forEach(id => {
    const victim = byId(id);
    if (victim && victim.isAlive) {
      victim.isAlive = false;
      victim.awaitingLastWords = true;
      deadNames.push(victim.name);
      io.to(victim.id).emit('player:you_died', { reason: 'Ночное покушение', timeForLastWords: 20 });

      if (victim.role === 'cultist') {
        room.players.forEach(p => { p.isCultMember = false; });
        sendSystemChat(roomId, '🕯️ Проповедник погиб! Тайный культ сектантов распался.');
      }
    }
  });

  checkMirrorTransformations(room);
  broadcastCultUpdate(room);

  if (luckySurvivedMessage) sendSystemChat(roomId, luckySurvivedMessage);

  if (deadNames.length > 0) {
    room.status = PHASES.MORNING_LAST_WORDS;
    sendSystemChat(roomId, `🌅 Наступает утро. Этой ночью погибли: ${deadNames.join(', ')}. Ожидаем их предсмертное послание (20 сек)...`);
    emitRoom(room);
    emitPhase(room, {
      status: PHASES.MORNING_LAST_WORDS,
      round: room.round,
      timeLeft: 20,
      message: `Убиты: ${deadNames.join(', ')}. Они оставляют предсмертную записку...`
    });
    setTimer(room, () => {
      room.players.forEach(p => { p.awaitingLastWords = false; });
      proceedAfterMorning(roomId);
    }, 20000);
  } else {
    sendSystemChat(roomId, '🌅 Наступает утро! Этой ночью никто не погиб.');
    proceedAfterMorning(roomId);
  }
}

function getEffectiveFactionForJournalist(player, framedPlayerId) {
  if (player.id === framedPlayerId) return 'BLACK';
  if (['RED', 'BLACK', 'CULT'].includes(player.faction)) return player.faction;
  return `SOLO_${player.id}`;
}

function checkMirrorTransformations(room) {
  room.players.forEach(player => {
    if (player.isAlive && player.role === 'mirror' && player.mirrorDonorId) {
      const donor = room.players.find(p => p.id === player.mirrorDonorId);
      if (donor && !donor.isAlive) {
        player.role = donor.originalRole;
        player.faction = donor.faction;
        player.mirrorDonorId = null;
        io.to(player.id).emit('mirror:transformed', {
          newRole: player.role,
          newFaction: player.faction,
          donorName: donor.name
        });
        if (player.faction === 'BLACK') {
          const team = room.players.filter(p => p.faction === 'BLACK').map(p => ({ id: p.id, name: p.name, role: p.role }));
          room.players.forEach(p => { if (p.faction === 'BLACK') io.to(p.id).emit('mafia:acquaintance', team); });
        }
      }
    }
  });
}

function broadcastCultUpdate(room) {
  const cultMembers = room.players.filter(p => p.isAlive && p.isCultMember).map(p => p.name);
  room.players.forEach(p => {
    io.to(p.id).emit('cult:update', p.isAlive && p.isCultMember ? cultMembers : []);
  });
}

function proceedAfterMorning(roomId) {
  const room = rooms.get(roomId);
  if (!room || ![PHASES.NIGHT, PHASES.MORNING_LAST_WORDS].includes(room.status)) return;
  clearTimeout(room.phaseTimer);
  if (checkWinConditions(roomId)) return;

  room.status = PHASES.DAY;
  emitRoom(room);
  emitPhase(room, {
    status: PHASES.DAY,
    round: room.round,
    timeLeft: room.settings.discussionTime,
    message: `День ${room.round}. Обсуждение в общем чате!`
  });
  setTimer(room, () => startVotingPhase(roomId), room.settings.discussionTime * 1000);
}

function startVotingPhase(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.status !== PHASES.DAY) return;

  room.status = PHASES.VOTING;
  room.dayVotes = {};
  sendSystemChat(roomId, '⚖️ Началось дневное голосование! Выберите кандидата на изгнание.');
  emitRoom(room);
  emitPhase(room, {
    status: PHASES.VOTING,
    round: room.round,
    timeLeft: room.settings.votingTime,
    message: 'Голосование за изгнание подозреваемого!'
  });
  setTimer(room, () => resolveDayVoting(roomId), room.settings.votingTime * 1000);
}

function nextRound(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.round += 1;
  startNightPhase(roomId);
}

// Итог первого голосования: выбираем обвиняемого и переходим к вердикту «да/нет»
function resolveDayVoting(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.status !== PHASES.VOTING) return;

  const counts = {};
  Object.values(room.dayVotes).forEach(id => { counts[id] = (counts[id] || 0) + 1; });

  let maxVotes = 0;
  let accusedId = null;
  let tie = false;
  for (const [id, count] of Object.entries(counts)) {
    if (count > maxVotes) { maxVotes = count; accusedId = id; tie = false; }
    else if (count === maxVotes) tie = true;
  }

  const summary = Object.entries(counts)
    .map(([id, n]) => `${room.players.find(p => p.id === id)?.name}: ${n}`).join(', ');
  if (summary) sendSystemChat(roomId, `📊 Итоги голосования: ${summary}.`);

  if (!accusedId || tie) {
    sendSystemChat(roomId, '⚖️ Голоса разделились или никто не проголосовал. Сегодня никто не казнен.');
    return nextRound(roomId);
  }

  const accused = room.players.find(p => p.id === accusedId);
  if (!accused || !accused.isAlive) return nextRound(roomId);

  startConfirmPhase(roomId, accused);
}

function startConfirmPhase(roomId, accused) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.status = PHASES.CONFIRM_VOTE;
  room.accusedId = accused.id;
  room.confirmVotes = {};
  sendSystemChat(roomId, `⚖️ Город выдвинул на казнь ${accused.name}. Вешаем игрока? Голосуем ДА или НЕТ!`);
  emitRoom(room);
  emitPhase(room, {
    status: PHASES.CONFIRM_VOTE,
    round: room.round,
    timeLeft: room.settings.confirmTime,
    message: `Вешаем ${accused.name}? Решите ДА или НЕТ!`
  });
  setTimer(room, () => resolveConfirm(roomId), room.settings.confirmTime * 1000);
}

function resolveConfirm(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.status !== PHASES.CONFIRM_VOTE) return;
  clearTimeout(room.phaseTimer);

  const accused = room.players.find(p => p.id === room.accusedId);
  const votes = Object.values(room.confirmVotes);
  const yes = votes.filter(v => v === 'yes').length;
  const no = votes.filter(v => v === 'no').length;
  room.accusedId = null;

  if (!accused || !accused.isAlive) return nextRound(roomId);

  sendSystemChat(roomId, `📊 Вердикт: ЗА — ${yes}, ПРОТИВ — ${no}.`);
  if (yes > no) return executeDay(roomId, accused.id);

  sendSystemChat(roomId, `🕊️ Город помиловал ${accused.name}. Сегодня никто не казнен.`);
  nextRound(roomId);
}

function executeDay(roomId, executedId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const executed = room.players.find(p => p.id === executedId);
  if (!executed || !executed.isAlive) return nextRound(roomId);

  executed.isAlive = false;
  io.to(executed.id).emit('player:you_died', { reason: 'Казнь по решению города', timeForLastWords: 0 });
  sendSystemChat(roomId, `🔨 По решению города казнен ${executed.name}. Его роль была: ${roleRu(executed.role)}!`);

  if (executed.role === 'cultist') {
    room.players.forEach(p => { p.isCultMember = false; });
    broadcastCultUpdate(room);
    sendSystemChat(roomId, '🕯️ Казненный оказался Проповедником! Секта распалась.');
  }

  if (executed.role === 'suicider') {
    clearTimeout(room.phaseTimer);
    room.status = PHASES.GAME_OVER;
    room.winner = `🃏 САМОУБИЙЦА (${executed.name}) одержал сольную победу, добившись собственной казни днем!`;
    sendSystemChat(roomId, room.winner);
    emitRoom(room);
    io.to(roomId).emit('game:over', { winner: room.winner });
    return;
  }

  checkMirrorTransformations(room);

  if (executed.role === 'kamikaze') {
    const aliveTargets = room.players.filter(p => p.isAlive);
    if (aliveTargets.length > 0) {
      room.status = PHASES.KAMIKAZE_REVENGE;
      room.kamikazeActorId = executed.id;
      sendSystemChat(roomId, `💣 ${executed.name} оказался КАМИКАДЗЕ! У него есть 15 секунд, чтобы утащить одного игрока за собой в могилу!`);
      emitRoom(room);
      emitPhase(room, {
        status: PHASES.KAMIKAZE_REVENGE,
        round: room.round,
        timeLeft: 15,
        message: `Камикадзе ${executed.name} выбирает, кого взорвать вместе с собой!`
      });
      setTimer(room, () => {
        const alive = room.players.filter(p => p.isAlive);
        if (alive.length) executeKamikazeRevenge(roomId, alive[Math.floor(Math.random() * alive.length)].id);
      }, 15000);
      return;
    }
  }

  if (!checkWinConditions(roomId)) nextRound(roomId);
}

function executeKamikazeRevenge(roomId, targetId) {
  const room = rooms.get(roomId);
  if (!room || room.status !== PHASES.KAMIKAZE_REVENGE) return;
  clearTimeout(room.phaseTimer);

  const victim = room.players.find(p => p.id === targetId && p.isAlive);
  if (victim) {
    victim.isAlive = false;
    sendSystemChat(roomId, `💥 КАМИКАДЗЕ подорвал вместе с собой игрока ${victim.name} (роль: ${roleRu(victim.role)})!`);
    io.to(victim.id).emit('player:you_died', { reason: 'Взрыв Камикадзе на дневном голосовании', timeForLastWords: 0 });
    if (victim.role === 'cultist') {
      room.players.forEach(p => { p.isCultMember = false; });
      broadcastCultUpdate(room);
    }
  }

  room.kamikazeActorId = null;
  checkMirrorTransformations(room);

  if (!checkWinConditions(roomId)) nextRound(roomId);
}

function checkWinConditions(roomId) {
  const room = rooms.get(roomId);
  if (!room) return false;

  const alive = room.players.filter(p => p.isAlive);
  const aliveBlack = alive.filter(p => p.faction === 'BLACK');
  const aliveNecro = alive.filter(p => p.role === 'necromancer');
  const cultLeaderAlive = alive.some(p => p.role === 'cultist');

  let winnerText = null;

  if (alive.length === 0) {
    winnerText = '💀 Все жители города погибли. Ничья!';
  } else if (alive.length === 1 && aliveNecro.length === 1) {
    winnerText = `🔮 НЕКРОМАНТ (${aliveNecro[0].name}) остался последним выжившим и захватил власть над городом!`;
  } else if (cultLeaderAlive && alive.every(p => p.isCultMember)) {
    winnerText = '🕯️ СЕКТА ПРОПОВЕДНИКА победила! Все выжившие жители обращены в тайный культ!';
  } else if (aliveBlack.length === 0 && aliveNecro.length === 0) {
    winnerText = '🛡️ МИРНЫЕ ЖИТЕЛИ победили! Мафия и темные силы полностью нейтрализованы.';
  } else if (aliveBlack.length >= alive.length - aliveBlack.length && aliveNecro.length === 0) {
    winnerText = '🦹‍♂️ МАФИЯ победила, установив полный контроль над городом!';
  }

  if (winnerText) {
    clearTimeout(room.phaseTimer);
    room.status = PHASES.GAME_OVER;
    room.winner = winnerText;
    sendSystemChat(roomId, `🏆 ИГРА ОКОНЧЕНА: ${winnerText}`);
    emitRoom(room);
    io.to(roomId).emit('game:over', { winner: winnerText });
    return true;
  }
  return false;
}

// Express 5 не принимает '*', поэтому обычный middleware
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
