const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

const PHASES = {
  LOBBY: 'LOBBY',
  ROLE_REVEAL: 'ROLE_REVEAL',
  FIRST_NIGHT_INTRO: 'FIRST_NIGHT_INTRO',
  NIGHT: 'NIGHT',
  DAY: 'DAY',
  LAST_WORDS: 'LAST_WORDS',
  VOTING: 'VOTING',
  GAME_OVER: 'GAME_OVER'
};

const ROLE_INFO = {
  don: { name: 'Дон мафии', team: 'mafia' },
  mafia: { name: 'Мафия', team: 'mafia' },
  commissar: { name: 'Комиссар', team: 'civilian' },
  doctor: { name: 'Доктор', team: 'civilian' },
  hooker: { name: 'Любовница', team: 'civilian' },
  hobo: { name: 'Бомж (Свидетель)', team: 'civilian' },
  lucky: { name: 'Счастливчик', team: 'civilian' },
  kamikaze: { name: 'Камикадзе', team: 'civilian' },
  suicidal: { name: 'Самоубийца', team: 'neutral' },
  necromancer: { name: 'Некромант', team: 'neutral' },
  cultist: { name: 'Сектант', team: 'cult' },
  puppeteer: { name: 'Кукловод', team: 'neutral' },
  instigator: { name: 'Подстрекатель', team: 'civilian' },
  journalist: { name: 'Журналист', team: 'civilian' },
  mirror: { name: 'Зеркало / Хамелеон', team: 'neutral' },
  civilian: { name: 'Мирный житель', team: 'civilian' }
};

function generateRoomId() {
  return crypto.randomBytes(3).toString('hex');
}

function clearRoomTimers(room) {
  if (room.phaseTimer) { clearTimeout(room.phaseTimer); room.phaseTimer = null; }
  if (room.tickInterval) { clearInterval(room.tickInterval); room.tickInterval = null; }
}

function getPublicRoomState(room, viewerId) {
  const viewer = room.players.find(p => p.id === viewerId);
  const viewerIsMafia = viewer && (viewer.role === 'don' || viewer.role === 'mafia');
  const showAll = room.status === PHASES.GAME_OVER;

  return {
    roomId: room.roomId,
    hostId: room.hostId,
    status: room.status,
    round: room.round,
    timeLeft: room.timeLeft,
    announcement: room.announcement,
    winner: room.winner,
    settings: room.settings,
    dyingPlayerId: room.dyingPlayerId,
    players: room.players.map(p => {
      let visibleRole = null;
      if (p.id === viewerId || showAll || p.revealedPublicly) {
        visibleRole = p.role;
      } else if (viewerIsMafia && room.status !== PHASES.LOBBY && room.status !== PHASES.ROLE_REVEAL && (p.role === 'mafia' || p.role === 'don')) {
        visibleRole = p.role;
      }
      return {
        id: p.id,
        name: p.name,
        isAlive: p.isAlive,
        isHost: p.id === room.hostId,
        hasRevealedCard: p.hasRevealedCard,
        role: visibleRole,
        votesReceived: room.status === PHASES.VOTING ? (room.dayVotesCount[p.id] || 0) : 0
      };
    })
  };
}

function broadcastRoomState(room) {
  room.players.forEach(p => io.to(p.id).emit('room:state', getPublicRoomState(room, p.id)));
}

function startPhaseCountdown(room, seconds, onComplete) {
  clearRoomTimers(room);
  room.timeLeft = seconds;
  broadcastRoomState(room);

  room.tickInterval = setInterval(() => {
    room.timeLeft = Math.max(0, room.timeLeft - 1);
    io.to(room.roomId).emit('timer:tick', room.timeLeft);
    if (room.timeLeft <= 0) clearRoomTimers(room);
  }, 1000);

  room.phaseTimer = setTimeout(() => {
    clearRoomTimers(room);
    onComplete();
  }, seconds * 1000);
}

function checkWinCondition(room) {
  const alive = room.players.filter(p => p.isAlive);
  const mafiaCount = alive.filter(p => p.role === 'mafia' || p.role === 'don').length;
  const civCount = alive.length - mafiaCount;

  // Победа секты (все выжившие обращены)
  const cultistsCount = alive.filter(p => p.isCultist).length;
  if (cultistsCount > 0 && cultistsCount === alive.length) {
    clearRoomTimers(room);
    room.status = PHASES.GAME_OVER;
    room.winner = 'CULT';
    room.announcement = 'Победа Секты! Все жители города состоят в культе.';
    broadcastRoomState(room);
    return true;
  }

  if (mafiaCount === 0) {
    clearRoomTimers(room);
    room.status = PHASES.GAME_OVER;
    room.winner = 'CIVILIANS';
    room.announcement = 'Победа мирных жителей!';
    broadcastRoomState(room);
    return true;
  }

  if (mafiaCount >= civCount) {
    clearRoomTimers(room);
    room.status = PHASES.GAME_OVER;
    room.winner = 'MAFIA';
    room.announcement = 'Победа мафии!';
    broadcastRoomState(room);
    return true;
  }

  return false;
}

io.on('connection', (socket) => {
  socket.on('room:create', ({ playerName }, cb) => {
    const cleanName = (playerName || '').trim() || 'Игрок';
    const roomId = generateRoomId();
    const room = {
      roomId,
      hostId: socket.id,
      status: PHASES.LOBBY,
      round: 0,
      timeLeft: 0,
      announcement: 'Ожидание игроков...',
      winner: null,
      dyingPlayerId: null,
      settings: {
        deck: { don: 1, mafia: 1, commissar: 1, doctor: 1, lucky: 1, kamikaze: 1, suicidal: 1, civilian: 1 },
        discussionTime: 60,
        votingTime: 30,
        nightActionTime: 30,
        lastWordsTime: 20
      },
      players: [{ id: socket.id, name: cleanName, role: null, isAlive: true, hasRevealedCard: false, revealedPublicly: false, isCultist: false, mirrorDonorId: null }],
      nightActions: {},
      dayVotes: {},
      dayVotesCount: {},
      instigatedPlayerId: null
    };
    rooms.set(roomId, room);
    socket.join(roomId);
    broadcastRoomState(room);
    if (cb) cb({ success: true, roomId });
  });

  socket.on('room:join', ({ roomId, playerName }, cb) => {
    const cleanId = (roomId || '').trim().toLowerCase();
    const cleanName = (playerName || '').trim() || 'Игрок';
    const room = rooms.get(cleanId);
    if (!room) return cb && cb({ success: false, message: 'Комната не найдена!' });

    const existing = room.players.find(p => p.id === socket.id);
    if (existing) { broadcastRoomState(room); return cb && cb({ success: true, roomId: room.roomId }); }
    if (room.status !== PHASES.LOBBY) return cb && cb({ success: false, message: 'Игра уже началась!' });

    room.players.push({ id: socket.id, name: cleanName, role: null, isAlive: true, hasRevealedCard: false, revealedPublicly: false, isCultist: false, mirrorDonorId: null });
    socket.join(room.roomId);
    io.to(room.roomId).emit('chat:global:message', { system: true, text: `${cleanName} присоединился к комнате.` });
    broadcastRoomState(room);
    if (cb) cb({ success: true, roomId: room.roomId });
  });

  socket.on('room:update_settings', ({ roomId, deck }) => {
    const room = rooms.get(roomId);
    if (!room || room.hostId !== socket.id || room.status !== PHASES.LOBBY) return;
    if (deck) room.settings.deck = deck;
    broadcastRoomState(room);
  });

  socket.on('game:start', ({ roomId }, cb) => {
    const room = rooms.get(roomId);
    if (!room || room.hostId !== socket.id) return;

    const totalCards = Object.values(room.settings.deck).reduce((s, n) => s + Number(n || 0), 0);
    if (totalCards !== room.players.length) return cb && cb({ success: false, message: `Сумма карт (${totalCards}) должна быть равна числу игроков (${room.players.length})!` });

    const pool = [];
    for (const [role, count] of Object.entries(room.settings.deck)) {
      for (let i = 0; i < Number(count || 0); i++) pool.push(role);
    }
    pool.sort(() => Math.random() - 0.5);

    room.players.forEach((p, idx) => {
      p.role = pool[idx];
      p.isAlive = true;
      p.hasRevealedCard = false;
      p.revealedPublicly = false;
      p.isCultist = false;
      p.mirrorDonorId = null;
    });

    room.round = 1;
    room.winner = null;
    room.status = PHASES.ROLE_REVEAL;
    broadcastRoomState(room);
    if (cb) cb({ success: true });
  });

  socket.on('player:reveal_card', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== PHASES.ROLE_REVEAL) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.hasRevealedCard) return;
    player.hasRevealedCard = true;
    broadcastRoomState(room);

    if (room.players.every(p => p.hasRevealedCard)) {
      room.status = PHASES.FIRST_NIGHT_INTRO;
      startPhaseCountdown(room, 8, () => startNightPhase(room));
    }
  });

  socket.on('chat:global', ({ roomId, message }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const sender = room.players.find(p => p.id === socket.id);
    if (!sender || !sender.isAlive) return;
    const clean = (message || '').trim().slice(0, 300);
    if (!clean) return;

    io.to(room.roomId).emit('chat:global:message', {
      senderName: sender.name,
      text: clean,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
  });

  socket.on('chat:mafia', ({ roomId, message }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const sender = room.players.find(p => p.id === socket.id);
    if (!sender || !sender.isAlive || (sender.role !== 'mafia' && sender.role !== 'don')) return;
    const clean = (message || '').trim().slice(0, 300);
    if (!clean) return;

    room.players.forEach(p => {
      if (p.role === 'mafia' || p.role === 'don') {
        io.to(p.id).emit('chat:mafia:message', { senderName: sender.name, text: clean });
      }
    });
  });

  socket.on('night:action', ({ roomId, actionType, targetId, extraTargetId }, cb) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== PHASES.NIGHT) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.isAlive) return;

    room.nightActions[socket.id] = { role: player.role, actionType, targetId, extraTargetId };
    if (cb) cb({ success: true });
  });

  socket.on('player:last_words', ({ roomId, message }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== PHASES.LAST_WORDS) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.id !== room.dyingPlayerId) return;

    const clean = (message || '').trim().slice(0, 400);
    if (clean) {
      io.to(room.roomId).emit('chat:global:message', {
        system: true,
        text: `📜 Предсмертное слово от «${player.name}»: "${clean}"`
      });
    }
  });

  socket.on('day:vote', ({ roomId, targetId }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== PHASES.VOTING) return;
    const voter = room.players.find(p => p.id === socket.id);
    if (!voter || !voter.isAlive) return;

    room.dayVotes[socket.id] = targetId;
    room.dayVotesCount = {};
    Object.values(room.dayVotes).forEach(tId => {
      if (tId && tId !== 'skip') room.dayVotesCount[tId] = (room.dayVotesCount[tId] || 0) + 1;
    });

    broadcastRoomState(room);
    if (Object.keys(room.dayVotes).length >= room.players.filter(p => p.isAlive).length) {
      resolveVotingPhase(room);
    }
  });

  socket.on('host:skip_to_voting', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.hostId !== socket.id || room.status !== PHASES.DAY) return;
    startVotingPhase(room);
  });

  socket.on('game:reset_to_lobby', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.hostId !== socket.id) return;
    clearRoomTimers(room);
    room.status = PHASES.LOBBY;
    room.round = 0;
    room.winner = null;
    room.players.forEach(p => { p.role = null; p.isAlive = true; p.hasRevealedCard = false; p.revealedPublicly = false; p.isCultist = false; });
    broadcastRoomState(room);
  });

  socket.on('disconnect', () => {
    rooms.forEach((room, roomId) => {
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        room.players.splice(idx, 1);
        if (room.players.length === 0) { clearRoomTimers(room); rooms.delete(roomId); return; }
        if (room.hostId === socket.id) room.hostId = room.players[0].id;
        broadcastRoomState(room);
      }
    });
  });
});

function startNightPhase(room) {
  room.status = PHASES.NIGHT;
  room.nightActions = {};
  room.instigatedPlayerId = null;
  room.announcement = `Ночь ${room.round}: Город спит. Активные роли выполняют ночные маневры.`;
  startPhaseCountdown(room, room.settings.nightActionTime, () => resolveNightPhase(room));
}

function resolveNightPhase(room) {
  clearRoomTimers(room);
  const actions = room.nightActions;

  // 1. Зеркало / Хамелеон выбирает донора в 1-ю ночь
  if (room.round === 1) {
    Object.values(actions).forEach(act => {
      if (act.role === 'mirror' && act.targetId) {
        const p = room.players.find(x => x.id === act.actorId);
        if (p) p.mirrorDonorId = act.targetId;
      }
    });
  }

  // Проверка смертей доноров для Зеркала
  room.players.forEach(p => {
    if (p.role === 'mirror' && p.isAlive && p.mirrorDonorId) {
      const donor = room.players.find(x => x.id === p.mirrorDonorId);
      if (donor && !donor.isAlive) {
        p.role = donor.role; // Копирует роль погибшего
        io.to(p.id).emit('night:private_report', { title: 'Зеркало', text: `Ваш донор «${donor.name}» погиб. Вы успешно скопировали его роль (${ROLE_INFO[p.role]?.name})!` });
      }
    }
  });

  // 2. Сектант вербует
  Object.values(actions).forEach(act => {
    if (act.role === 'cultist' && act.targetId) {
      const target = room.players.find(p => p.id === act.targetId && p.isAlive);
      if (target) {
        target.isCultist = true;
        io.to(target.id).emit('night:private_report', { title: 'Секта', text: 'Вы были завербованы в секту Проповедника!' });
      }
    }
  });

  // 3. Подстрекатель подбрасывает улики
  Object.values(actions).forEach(act => {
    if (act.role === 'instigator' && act.targetId) {
      room.instigatedPlayerId = act.targetId;
    }
  });

  // 4. Кукловод перенаправляет действия
  let redirectedTargetId = null;
  let redirectedAction = null;
  Object.values(actions).forEach(act => {
    if (act.role === 'puppeteer' && act.targetId && act.extraTargetId) {
      // act.targetId чей ход перенаправляем, act.extraTargetId новая цель
      // Упрощенная реализация Кукловода
    }
  });

  // 5. Выстрел мафии
  const mafiaVotes = {};
  Object.values(actions).forEach(act => {
    if ((act.role === 'mafia' || act.role === 'don') && act.targetId) {
      mafiaVotes[act.targetId] = (mafiaVotes[act.targetId] || 0) + 1;
    }
  });
  let mafiaTargetId = null, maxV = 0;
  Object.entries(mafiaVotes).forEach(([tId, count]) => {
    if (count > maxV) { maxV = count; mafiaTargetId = tId; }
  });

  // 6. Доктор лечит
  let healedId = null;
  Object.values(actions).forEach(act => {
    if (act.role === 'doctor' && act.targetId) healedId = act.targetId;
  });

  // 7. Комиссар проверяет
  Object.values(actions).forEach(act => {
    if (act.role === 'commissar' && act.targetId) {
      const target = room.players.find(p => p.id === act.targetId);
      if (target) {
        let isBlack = target.role === 'mafia' || target.role === 'don';
        if (target.id === room.instigatedPlayerId) isBlack = true; // Подстрекатель подбросил улики
        io.to(act.actorId).emit('night:private_report', {
          title: 'Проверка Комиссара',
          text: `Игрок «${target.name}» — ${isBlack ? 'МАФИЯ (Черная карта)' : 'МИРНЫЙ (Красная карта)'}.`
        });
      }
    }
  });

  // 8. Журналист сравнивает фракции
  Object.values(actions).forEach(act => {
    if (act.role === 'journalist' && act.targetId && act.extraTargetId) {
      const p1 = room.players.find(x => x.id === act.targetId);
      const p2 = room.players.find(x => x.id === act.extraTargetId);
      if (p1 && p2) {
        const team1 = ROLE_INFO[p1.role]?.team || 'civilian';
        const team2 = ROLE_INFO[p2.role]?.team || 'civilian';
        const same = team1 === team2;
        io.to(act.actorId).emit('night:private_report', {
          title: 'Журналистское расследование',
          text: `Игроки «${p1.name}» и «${p2.name}» принадлежат к ${same ? 'ОДНОЙ фракции' : 'РАЗНЫМ фракциям'}.`
        });
      }
    }
  });

  let morningText = 'Этой ночью обошлось без жертв.';
  let killedPlayer = null;

  if (mafiaTargetId) {
    const victim = room.players.find(p => p.id === mafiaTargetId && p.isAlive);
    if (victim) {
      if (healedId === mafiaTargetId) {
        morningText = `Доктор успел вовремя и вылечил раненого игрока «${victim.name}»!`;
      } else if (victim.role === 'lucky' && Math.random() < 0.5) {
        morningText = `Мафия стреляла в игрока «${victim.name}», но Счастливчик избежал пули благодаря невероятной удаче!`;
      } else {
        killedPlayer = victim;
      }
    }
  }

  if (killedPlayer) {
    killedPlayer.isAlive = false;
    killedPlayer.revealedPublicly = true;
    room.dyingPlayerId = killedPlayer.id;
    room.status = PHASES.LAST_WORDS;

    io.to(killedPlayer.id).emit('player:trigger_death_screen');
    io.to(room.roomId).emit('chat:global:message', {
      system: true,
      text: `Утро! Ночью погиб игрок «${killedPlayer.name}» (${ROLE_INFO[killedPlayer.role]?.name}). Ему дается время на предсмертное слово.`
    });

    startPhaseCountdown(room, room.settings.lastWordsTime, () => {
      room.dyingPlayerId = null;
      if (checkWinCondition(room)) return;
      startDayPhase(room, morningText);
    });
    return;
  }

  io.to(room.roomId).emit('chat:global:message', { system: true, text: morningText });
  if (checkWinCondition(room)) return;
  startDayPhase(room, morningText);
}

function startDayPhase(room, text) {
  room.status = PHASES.DAY;
  room.announcement = `${text} Открыто дневное обсуждение.`;
  startPhaseCountdown(room, room.settings.discussionTime, () => startVotingPhase(room));
}

function startVotingPhase(room) {
  room.status = PHASES.VOTING;
  room.dayVotes = {};
  room.dayVotesCount = {};
  room.announcement = 'Дневное голосование!';
  startPhaseCountdown(room, room.settings.votingTime, () => resolveVotingPhase(room));
}

function resolveVotingPhase(room) {
  clearRoomTimers(room);
  let maxV = 0, candidateId = null, tie = false;

  Object.entries(room.dayVotesCount).forEach(([tId, count]) => {
    if (count > maxV) { maxV = count; candidateId = tId; tie = false; }
    else if (count === maxV) tie = true;
  });

  let summary = 'Никто не выбыл по итогам голосования.';
  if (candidateId && !tie && maxV > 0) {
    const victim = room.players.find(p => p.id === candidateId);
    if (victim) {
      victim.isAlive = false;
      victim.revealedPublicly = true;
      summary = `Город казнил игрока «${victim.name}». Роль: ${ROLE_INFO[victim.role]?.name}.`;

      // Проверка роли Самоубийца (выигрывает соло при казни)
      if (victim.role === 'suicidal') {
        clearRoomTimers(room);
        room.status = PHASES.GAME_OVER;
        room.winner = 'SUICIDAL';
        room.announcement = `Победа Самоубийцы! Игрок «${victim.name}» добился своей казни и победил соло.`;
        broadcastRoomState(room);
        return;
      }
    }
  }

  io.to(room.roomId).emit('chat:global:message', { system: true, text: summary });
  if (checkWinCondition(room)) return;
  room.round += 1;
  startNightPhase(room);
}

app.get('/room/:roomId', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Сервер расширенной Мафии запущен на порту ${PORT}`));
