const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// Раздаем статические файлы фронтенда из папки public
app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

const PHASES = {
  LOBBY: 'LOBBY',
  ROLE_REVEAL: 'ROLE_REVEAL',
  FIRST_NIGHT_INTRO: 'FIRST_NIGHT_INTRO',
  NIGHT: 'NIGHT',
  DAY: 'DAY',
  VOTING: 'VOTING',
  GAME_OVER: 'GAME_OVER'
};

io.on('connection', (socket) => {
  console.log(`Игрок подключился: ${socket.id}`);

  // Создание комнаты
  socket.on('room:create', ({ playerName }, callback) => {
    const roomId = uuidv4().substring(0, 6);
    const room = {
      roomId,
      hostId: socket.id,
      status: PHASES.LOBBY,
      settings: {
        deck: { civilian: 3, mafia: 1, don: 1, commissar: 1, doctor: 1, hooker: 1, hobo: 1 },
        discussionTime: 60,
        nightActionTime: 30
      },
      players: [{
        id: socket.id,
        name: playerName,
        role: null,
        isAlive: true,
        isHost: true,
        hasRevealedCard: false
      }],
      phaseTimer: null,
      nightActions: {
        hooker: null,
        mafiaVotes: {},
        doctor: null,
        doctorLast: null,
        commissar: null,
        hobo: null
      },
      visits: {}
    };

    rooms.set(roomId, room);
    socket.join(roomId);
    callback({ success: true, roomId });
  });

  // Вход в комнату
  socket.on('room:join', ({ roomId, playerName }, callback) => {
    const room = rooms.get(roomId);
    if (!room) return callback({ success: false, message: 'Комната не найдена' });
    if (room.status !== PHASES.LOBBY) return callback({ success: false, message: 'Игра уже началась' });

    room.players.push({
      id: socket.id,
      name: playerName,
      role: null,
      isAlive: true,
      isHost: false,
      hasRevealedCard: false
    });

    socket.join(roomId);
    io.to(roomId).emit('room:update', room);
    callback({ success: true, room });
  });

  // Старт игры
  socket.on('game:start', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.hostId !== socket.id) return;

    const totalCards = Object.values(room.settings.deck).reduce((a, b) => a + b, 0);
    if (totalCards !== room.players.length) {
      return socket.emit('error', 'Количество ролей не равно числу игроков!');
    }

    let rolesPool = [];
    for (const [role, count] of Object.entries(room.settings.deck)) {
      for (let i = 0; i < count; i++) rolesPool.push(role);
    }
    rolesPool = rolesPool.sort(() => Math.random() - 0.5);

    room.players.forEach((player, idx) => {
      player.role = rolesPool[idx];
      player.isAlive = true;
      player.hasRevealedCard = false;
    });

    room.status = PHASES.ROLE_REVEAL;
    io.to(roomId).emit('game:started', room);
  });

  // Вскрытие карты
  socket.on('player:reveal_card', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (player) player.hasRevealedCard = true;

    if (room.players.every(p => p.hasRevealedCard)) {
      room.status = PHASES.FIRST_NIGHT_INTRO;
      
      const mafiaPlayers = room.players
        .filter(p => p.role === 'mafia' || p.role === 'don')
        .map(p => ({ id: p.id, name: p.name, role: p.role }));

      room.players.forEach(p => {
        if (p.role === 'mafia' || p.role === 'don') {
          io.to(p.id).emit('mafia:acquaintance', mafiaPlayers);
        }
      });

      io.to(roomId).emit('game:phase_change', { status: room.status, message: 'Город засыпает... Знакомство мафии' });
      setTimeout(() => startNightPhase(roomId), 10000);
    }
  });

  // Ночной чат мафии
  socket.on('chat:mafia', ({ roomId, message }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== PHASES.NIGHT) return;

    const sender = room.players.find(p => p.id === socket.id);
    if (sender && (sender.role === 'mafia' || sender.role === 'don') && sender.isAlive) {
      room.players.forEach(p => {
        if ((p.role === 'mafia' || p.role === 'don') && p.isAlive) {
          io.to(p.id).emit('chat:mafia:message', { senderName: sender.name, message });
        }
      });
    }
  });

  // Ночные действия
  socket.on('night:action', ({ roomId, role, targetId }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== PHASES.NIGHT) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.isAlive) return;

    if (role === 'hooker' && player.role === 'hooker') room.nightActions.hooker = targetId;
    if (role === 'doctor' && player.role === 'doctor') room.nightActions.doctor = targetId;
    if (role === 'commissar' && player.role === 'commissar') room.nightActions.commissar = targetId;
    if (role === 'hobo' && player.role === 'hobo') room.nightActions.hobo = targetId;
    if ((role === 'mafia' || role === 'don') && (player.role === 'mafia' || player.role === 'don')) {
      room.nightActions.mafiaVotes[socket.id] = targetId;
    }
  });

  socket.on('disconnect', () => {
    console.log(`Игрок отключился: ${socket.id}`);
  });
});

function startNightPhase(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.status = PHASES.NIGHT;
  room.nightActions = { hooker: null, mafiaVotes: {}, doctor: null, commissar: null, hobo: null };
  room.visits = {};

  io.to(roomId).emit('game:phase_change', { status: PHASES.NIGHT, timeLeft: room.settings.nightActionTime });

  room.phaseTimer = setTimeout(() => {
    resolveNight(roomId);
  }, room.settings.nightActionTime * 1000);
}

function resolveNight(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const { hooker, doctor, doctorLast, mafiaVotes, commissar, hobo } = room.nightActions;
  let killedPlayerId = null;

  const registerVisit = (targetId, visitorRole) => {
    if (!targetId) return;
    if (!room.visits[targetId]) room.visits[targetId] = [];
    room.visits[targetId].push(visitorRole);
  };

  if (hooker) registerVisit(hooker, 'Любовница');
  if (doctor) registerVisit(doctor, 'Доктор');
  if (commissar) registerVisit(commissar, 'Комиссар');
  if (hobo) registerVisit(hobo, 'Бомж');
  Object.values(mafiaVotes).forEach(target => registerVisit(target, 'Мафия'));

  let blockedRoles = [];
  if (hooker) {
    const hookerTargetPlayer = room.players.find(p => p.id === hooker);
    if (hookerTargetPlayer) blockedRoles.push(hookerTargetPlayer.role);
  }

  const voteCounts = {};
  Object.values(mafiaVotes).forEach(target => {
    voteCounts[target] = (voteCounts[target] || 0) + 1;
  });
  let mafiaTarget = Object.keys(voteCounts).reduce((a, b) => voteCounts[a] > voteCounts[b] ? a : b, null);

  if (mafiaTarget && !blockedRoles.includes('mafia') && !blockedRoles.includes('don')) {
    killedPlayerId = mafiaTarget;
  }

  if (doctor && !blockedRoles.includes('doctor')) {
    if (doctor === doctorLast) {
      room.nightActions.doctorLast = null;
    } else {
      if (killedPlayerId === doctor) killedPlayerId = null;
      room.nightActions.doctorLast = doctor;
    }
  }

  if (killedPlayerId) {
    const victim = room.players.find(p => p.id === killedPlayerId);
    if (victim) victim.isAlive = false;
  }

  if (commissar && !blockedRoles.includes('commissar')) {
    const targetPlayer = room.players.find(p => p.id === commissar);
    if (targetPlayer) {
      const isMafia = targetPlayer.role === 'mafia' || targetPlayer.role === 'don';
      const commSocket = room.players.find(p => p.role === 'commissar')?.id;
      if (commSocket) io.to(commSocket).emit('commissar:result', { targetName: targetPlayer.name, isMafia });
    }
  }

  if (hobo && !blockedRoles.includes('hobo')) {
    const targetVisitors = room.visits[hobo] || [];
    const hoboSocket = room.players.find(p => p.role === 'hobo')?.id;
    if (hoboSocket) io.to(hoboSocket).emit('hobo:result', { visitors: targetVisitors });
  }

  io.to(roomId).emit('night:results', {
    killedPlayerId,
    message: killedPlayerId ? 'Ночью не обошлось без жертв.' : 'Этой ночью никто не погиб.'
  });

  startDayPhase(roomId);
}

function startDayPhase(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.status = PHASES.DAY;
  io.to(roomId).emit('game:phase_change', { status: PHASES.DAY, timeLeft: room.settings.discussionTime });

  room.phaseTimer = setTimeout(() => {
    room.status = PHASES.VOTING;
    io.to(roomId).emit('game:phase_change', { status: PHASES.VOTING, message: 'Началось дневное голосование!' });
  }, room.settings.discussionTime * 1000);
}

// Все остальные запросы отправляем на index.html (для SPA роутинга React)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
