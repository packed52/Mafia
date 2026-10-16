const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// Раздаем папку public
app.use(express.static(path.join(__dirname, 'public')));

// Хранилище комнат
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

const ROLE_NAMES = {
  don: 'Дон мафии',
  mafia: 'Мафия',
  commissar: 'Комиссар',
  doctor: 'Доктор',
  hooker: 'Любовница',
  hobo: 'Бомж (Свидетель)',
  civilian: 'Мирный житель'
};

function generateRoomId() {
  return crypto.randomBytes(3).toString('hex');
}

function clearRoomTimers(room) {
  if (room.phaseTimer) {
    clearTimeout(room.phaseTimer);
    room.phaseTimer = null;
  }
  if (room.tickInterval) {
    clearInterval(room.tickInterval);
    room.tickInterval = null;
  }
}

// Формируем безопасное состояние комнаты для конкретного игрока (не раскрывая чужие роли)
function getPublicRoomState(room, viewerId) {
  const viewer = room.players.find(p => p.id === viewerId);
  const viewerIsMafia = viewer && (viewer.role === 'mafia' || viewer.role === 'don');
  const showAllRoles = room.status === PHASES.GAME_OVER;

  return {
    roomId: room.roomId,
    hostId: room.hostId,
    status: room.status,
    round: room.round,
    timeLeft: room.timeLeft,
    announcement: room.announcement,
    winner: room.winner,
    settings: room.settings,
    doctorLastTarget: viewer && viewer.role === 'doctor' ? room.doctorLastTarget : null,
    players: room.players.map(p => {
      let visibleRole = null;
      if (p.id === viewerId || showAllRoles || p.revealedPublicly) {
        visibleRole = p.role;
      } else if (
        viewerIsMafia &&
        room.status !== PHASES.LOBBY &&
        room.status !== PHASES.ROLE_REVEAL &&
        (p.role === 'mafia' || p.role === 'don')
      ) {
        visibleRole = p.role; // Мафия и Дон видят друг друга с первой ночи
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
  room.players.forEach(p => {
    io.to(p.id).emit('room:state', getPublicRoomState(room, p.id));
  });
}

function startPhaseCountdown(room, seconds, onComplete) {
  clearRoomTimers(room);
  room.timeLeft = seconds;
  broadcastRoomState(room);

  room.tickInterval = setInterval(() => {
    room.timeLeft = Math.max(0, room.timeLeft - 1);
    io.to(room.roomId).emit('timer:tick', room.timeLeft);
    if (room.timeLeft <= 0) {
      clearRoomTimers(room);
    }
  }, 1000);

  room.phaseTimer = setTimeout(() => {
    clearRoomTimers(room);
    onComplete();
  }, seconds * 1000);
}

function checkWinCondition(room) {
  const alive = room.players.filter(p => p.isAlive);
  const mafiaCount = alive.filter(p => p.role === 'mafia' || p.role === 'don').length;
  const civilianCount = alive.length - mafiaCount;

  if (mafiaCount === 0) {
    clearRoomTimers(room);
    room.status = PHASES.GAME_OVER;
    room.winner = 'CIVILIANS';
    room.announcement = 'Победа мирных жителей! Вся мафия обезврежена.';
    broadcastRoomState(room);
    return true;
  }

  if (mafiaCount >= civilianCount) {
    clearRoomTimers(room);
    room.status = PHASES.GAME_OVER;
    room.winner = 'MAFIA';
    room.announcement = 'Победа мафии! Город захвачен.';
    broadcastRoomState(room);
    return true;
  }

  return false;
}

io.on('connection', (socket) => {
  // 1. Создание комнаты
  socket.on('room:create', ({ playerName }, cb) => {
    const cleanName = (playerName || '').trim() || 'Игрок';
    const roomId = generateRoomId();

    const room = {
      roomId,
      hostId: socket.id,
      status: PHASES.LOBBY,
      round: 0,
      timeLeft: 0,
      announcement: 'Ожидание игроков в лобби...',
      winner: null,
      settings: {
        deck: {
          don: 1,
          mafia: 1,
          commissar: 1,
          doctor: 1,
          hooker: 0,
          hobo: 0,
          civilian: 2
        },
        discussionTime: 60,
        votingTime: 30,
        nightActionTime: 30
      },
      players: [{
        id: socket.id,
        name: cleanName,
        role: null,
        isAlive: true,
        hasRevealedCard: false,
        revealedPublicly: false
      }],
      phaseTimer: null,
      tickInterval: null,
      doctorLastTarget: null,
      nightActions: {},
      dayVotes: {},
      dayVotesCount: {}
    };

    rooms.set(roomId, room);
    socket.join(roomId);
    broadcastRoomState(room);
    if (cb) cb({ success: true, roomId });
  });

  // 2. Вход в существующую комнату
  socket.on('room:join', ({ roomId, playerName }, cb) => {
    const cleanId = (roomId || '').trim().toLowerCase();
    const cleanName = (playerName || '').trim() || 'Игрок';
    const room = rooms.get(cleanId);

    if (!room) {
      return cb && cb({ success: false, message: 'Комната не найдена! Проверьте код или ссылку.' });
    }

    // Если игрок уже в комнате, просто обновляем состояние
    const existing = room.players.find(p => p.id === socket.id);
    if (existing) {
      broadcastRoomState(room);
      return cb && cb({ success: true, roomId: room.roomId });
    }

    if (room.status !== PHASES.LOBBY) {
      return cb && cb({ success: false, message: 'Игра в этой комнате уже началась!' });
    }

    room.players.push({
      id: socket.id,
      name: cleanName,
      role: null,
      isAlive: true,
      hasRevealedCard: false,
      revealedPublicly: false
    });

    socket.join(room.roomId);
    io.to(room.roomId).emit('chat:global:message', {
      system: true,
      text: `${cleanName} присоединился к комнате.`
    });
    broadcastRoomState(room);
    if (cb) cb({ success: true, roomId: room.roomId });
  });

  // 3. Настройка колоды и таймеров хостом
  socket.on('room:update_settings', ({ roomId, deck, discussionTime, nightActionTime }) => {
    const room = rooms.get(roomId);
    if (!room || room.hostId !== socket.id || room.status !== PHASES.LOBBY) return;

    if (deck) room.settings.deck = deck;
    if (discussionTime) room.settings.discussionTime = Number(discussionTime) || 60;
    if (nightActionTime) room.settings.nightActionTime = Number(nightActionTime) || 30;
    broadcastRoomState(room);
  });

  // 4. Возврат в лобби после окончания игры
  socket.on('game:reset_to_lobby', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.hostId !== socket.id) return;

    clearRoomTimers(room);
    room.status = PHASES.LOBBY;
    room.round = 0;
    room.winner = null;
    room.announcement = 'Настройте колоду и начните новую игру.';
    room.doctorLastTarget = null;
    room.players.forEach(p => {
      p.role = null;
      p.isAlive = true;
      p.hasRevealedCard = false;
      p.revealedPublicly = false;
    });
    broadcastRoomState(room);
  });

  // 5. Старт игры
  socket.on('game:start', ({ roomId }, cb) => {
    const room = rooms.get(roomId);
    if (!room || room.hostId !== socket.id) return;

    if (room.players.length < 3) {
      return cb && cb({ success: false, message: 'Для старта нужно минимум 3 игрока!' });
    }

    const totalCards = Object.values(room.settings.deck).reduce((sum, n) => sum + Number(n || 0), 0);
    if (totalCards !== room.players.length) {
      return cb && cb({
        success: false,
        message: `Сумма карт в колоде (${totalCards}) должна равняться числу игроков (${room.players.length})!`
      });
    }

    const mafiaTotal = Number(room.settings.deck.mafia || 0) + Number(room.settings.deck.don || 0);
    if (mafiaTotal < 1) {
      return cb && cb({ success: false, message: 'В колоде должен быть хотя бы 1 Мафиози или Дон!' });
    }

    // Перемешиваем колоду алгоритмом Фишера-Йетса
    const pool = [];
    for (const [role, count] of Object.entries(room.settings.deck)) {
      for (let i = 0; i < Number(count || 0); i++) {
        pool.push(role);
      }
    }
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    room.players.forEach((p, idx) => {
      p.role = pool[idx];
      p.isAlive = true;
      p.hasRevealedCard = false;
      p.revealedPublicly = false;
    });

    room.round = 1;
    room.winner = null;
    room.doctorLastTarget = null;
    room.status = PHASES.ROLE_REVEAL;
    room.announcement = 'Карты розданы! Нажмите на свою карту, чтобы вскрыть её и убрать в карман.';

    broadcastRoomState(room);
    if (cb) cb({ success: true });
  });

  // 6. Игрок вскрыл свою карту
  socket.on('player:reveal_card', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== PHASES.ROLE_REVEAL) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.hasRevealedCard) return;

    player.hasRevealedCard = true;
    broadcastRoomState(room);

    // Если все игроки вскрыли свои карты — запускаем Первую ночь (Знакомство мафии)
    if (room.players.every(p => p.hasRevealedCard)) {
      startFirstNightIntro(room);
    }
  });

  // 7. Общий чат (доступен в лобби и днем только для живых игроков)
  socket.on('chat:global', ({ roomId, message }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const sender = room.players.find(p => p.id === socket.id);
    if (!sender || !sender.isAlive) return;

    const allowedPhases = [PHASES.LOBBY, PHASES.DAY, PHASES.VOTING, PHASES.GAME_OVER];
    if (!allowedPhases.includes(room.status)) return;

    const cleanText = (message || '').trim().slice(0, 300);
    if (!cleanText) return;

    io.to(room.roomId).emit('chat:global:message', {
      senderName: sender.name,
      text: cleanText,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
  });

  // 8. Закрытый ночной чат мафии
  socket.on('chat:mafia', ({ roomId, message }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.status !== PHASES.NIGHT && room.status !== PHASES.FIRST_NIGHT_INTRO) return;

    const sender = room.players.find(p => p.id === socket.id);
    if (!sender || !sender.isAlive) return;
    if (sender.role !== 'mafia' && sender.role !== 'don') return;

    const cleanText = (message || '').trim().slice(0, 300);
    if (!cleanText) return;

    room.players.forEach(p => {
      if (p.role === 'mafia' || p.role === 'don') {
        io.to(p.id).emit('chat:mafia:message', {
          senderName: sender.name,
          role: ROLE_NAMES[sender.role],
          text: cleanText
        });
      }
    });
  });

  // 9. Ночные ходы активных ролей
  socket.on('night:action', ({ roomId, actionType, targetId }, cb) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== PHASES.NIGHT) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.isAlive) return;

    const target = room.players.find(p => p.id === targetId && p.isAlive);
    if (!target) return cb && cb({ success: false, message: 'Выберите живого игрока!' });

    if (player.role === 'doctor' && actionType === 'heal') {
      if (targetId === socket.id && room.doctorLastTarget === socket.id) {
        return cb && cb({ success: false, message: 'Доктор не может лечить себя два раза подряд!' });
      }
      room.nightActions.doctor = { actorId: socket.id, targetId };
    } else if (player.role === 'hooker' && actionType === 'block') {
      if (targetId === socket.id) {
        return cb && cb({ success: false, message: 'Нельзя заблокировать саму себя!' });
      }
      room.nightActions.hooker = { actorId: socket.id, targetId };
    } else if (player.role === 'commissar' && actionType === 'check') {
      room.nightActions.commissar = { actorId: socket.id, targetId };
    } else if (player.role === 'hobo' && actionType === 'watch') {
      room.nightActions.hobo = { actorId: socket.id, targetId };
    } else if ((player.role === 'mafia' || player.role === 'don') && actionType === 'kill') {
      room.nightActions.mafiaVotes[socket.id] = targetId;
      // Сообщаем соратникам по мафии о выборе мишени
      room.players.forEach(p => {
        if (p.role === 'mafia' || p.role === 'don') {
          io.to(p.id).emit('chat:mafia:message', {
            senderName: 'Система',
            role: 'Прицел',
            text: `${player.name} голосует за выстрел в игрока «${target.name}»`
          });
        }
      });
    } else if (player.role === 'don' && actionType === 'don_check') {
      room.nightActions.donCheck = { actorId: socket.id, targetId };
    }

    if (cb) cb({ success: true, targetName: target.name });
  });

  // 10. Дневное голосование
  socket.on('day:vote', ({ roomId, targetId }, cb) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== PHASES.VOTING) return;

    const voter = room.players.find(p => p.id === socket.id);
    if (!voter || !voter.isAlive) return;

    room.dayVotes[socket.id] = targetId; // targetId или 'skip'

    // Пересчитываем голоса
    room.dayVotesCount = {};
    Object.values(room.dayVotes).forEach(tId => {
      if (tId && tId !== 'skip') {
        room.dayVotesCount[tId] = (room.dayVotesCount[tId] || 0) + 1;
      }
    });

    broadcastRoomState(room);
    if (cb) cb({ success: true });

    // Если все живые проголосовали — завершаем голосование досрочно
    const alivePlayers = room.players.filter(p => p.isAlive);
    if (Object.keys(room.dayVotes).length >= alivePlayers.length) {
      resolveVotingPhase(room);
    }
  });

  // 11. Досрочный переход от дневного обсуждения к голосованию (для хоста)
  socket.on('host:skip_to_voting', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.hostId !== socket.id || room.status !== PHASES.DAY) return;
    startVotingPhase(room);
  });

  // 12. Отключение игрока
  socket.on('disconnect', () => {
    rooms.forEach((room, roomId) => {
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        const leaving = room.players[idx];
        room.players.splice(idx, 1);

        if (room.players.length === 0) {
          clearRoomTimers(room);
          rooms.delete(roomId);
          return;
        }

        if (room.hostId === socket.id) {
          room.hostId = room.players[0].id;
        }

        io.to(roomId).emit('chat:global:message', {
          system: true,
          text: `${leaving.name} покинул игру.`
        });

        if (room.status !== PHASES.LOBBY && room.status !== PHASES.GAME_OVER) {
          checkWinCondition(room);
        }
        broadcastRoomState(room);
      }
    });
  });
});

function startFirstNightIntro(room) {
  room.status = PHASES.FIRST_NIGHT_INTRO;
  room.announcement = 'Первая ночь: Город засыпает. Просыпается Мафия и знакомится друг с другом!';

  startPhaseCountdown(room, 10, () => {
    startNightPhase(room);
  });
}

function startNightPhase(room) {
  room.status = PHASES.NIGHT;
  room.nightActions = {
    hooker: null,
    mafiaVotes: {},
    donCheck: null,
    doctor: null,
    commissar: null,
    hobo: null
  };
  room.announcement = `Ночь ${room.round}: Город спит. Активные роли делают свой выбор.`;

  startPhaseCountdown(room, room.settings.nightActionTime, () => {
    resolveNightPhase(room);
  });
}

function resolveNightPhase(room) {
  clearRoomTimers(room);

  const { hooker, mafiaVotes, donCheck, doctor, commissar, hobo } = room.nightActions;
  const blockedPlayerIds = new Set();
  const visits = {}; // targetId -> [имена пришедших]

  const addVisit = (actorId, targetId) => {
    if (!actorId || !targetId || actorId === targetId) return;
    const actor = room.players.find(p => p.id === actorId);
    if (!actor) return;
    if (!visits[targetId]) visits[targetId] = [];
    if (!visits[targetId].includes(actor.name)) {
      visits[targetId].push(actor.name);
    }
  };

  // 1. Ход Любовницы (блокирует выбранного игрока)
  if (hooker && hooker.targetId) {
    blockedPlayerIds.add(hooker.targetId);
    addVisit(hooker.actorId, hooker.targetId);
    io.to(hooker.targetId).emit('night:private_report', {
      title: 'Ночной визит',
      text: 'К вам пришла Любовница! Ваше ночное действие было заблокировано.'
    });
  }

  // 2. Выстрел Мафии (учитываются только голоса НЕ заблокированных мафиози)
  const voteCounts = {};
  Object.entries(mafiaVotes).forEach(([mafiaId, targetId]) => {
    if (!blockedPlayerIds.has(mafiaId) && targetId) {
      voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
      addVisit(mafiaId, targetId);
    }
  });

  let mafiaTargetId = null;
  let maxVotes = 0;
  Object.entries(voteCounts).forEach(([tId, count]) => {
    if (count > maxVotes) {
      maxVotes = count;
      mafiaTargetId = tId;
    }
  });

  // 3. Лечение Доктора
  let healedTargetId = null;
  if (doctor && doctor.targetId && !blockedPlayerIds.has(doctor.actorId)) {
    healedTargetId = doctor.targetId;
    room.doctorLastTarget = doctor.targetId;
    addVisit(doctor.actorId, doctor.targetId);
  } else if (doctor && blockedPlayerIds.has(doctor.actorId)) {
    room.doctorLastTarget = null;
  }

  // 4. Проверка Комиссара
  if (commissar && commissar.targetId && !blockedPlayerIds.has(commissar.actorId)) {
    addVisit(commissar.actorId, commissar.targetId);
    const target = room.players.find(p => p.id === commissar.targetId);
    if (target) {
      const isBlack = target.role === 'mafia' || target.role === 'don';
      io.to(commissar.actorId).emit('night:private_report', {
        title: 'Проверка Комиссара',
        text: `Игрок «${target.name}» — ${isBlack ? 'МАФИЯ (Черная карта)' : 'МИРНЫЙ (Красная карта)'}.`
      });
    }
  }

  // 5. Проверка Дона на Комиссара
  if (donCheck && donCheck.targetId && !blockedPlayerIds.has(donCheck.actorId)) {
    const target = room.players.find(p => p.id === donCheck.targetId);
    if (target) {
      const isCommissar = target.role === 'commissar';
      io.to(donCheck.actorId).emit('night:private_report', {
        title: 'Проверка Дона',
        text: isCommissar
          ? `Игрок «${target.name}» — это КОМИССАР!`
          : `Игрок «${target.name}» НЕ является Комиссаром.`
      });
    }
  }

  // 6. Слежка Бомжа (Свидетеля)
  if (hobo && hobo.targetId && !blockedPlayerIds.has(hobo.actorId)) {
    addVisit(hobo.actorId, hobo.targetId);
    const target = room.players.find(p => p.id === hobo.targetId);
    const visitorsList = (visits[hobo.targetId] || []).filter(name => {
      const hoboPlayer = room.players.find(p => p.id === hobo.actorId);
      return !hoboPlayer || name !== hoboPlayer.name;
    });

    if (target) {
      io.to(hobo.actorId).emit('night:private_report', {
        title: 'Слежка Свидетеля (Бомжа)',
        text: visitorsList.length > 0
          ? `Ночью к игроку «${target.name}» приходили: ${visitorsList.join(', ')}.`
          : `Ночью к игроку «${target.name}» никто не приходил.`
      });
    }
  }

  // Итог выстрела мафии
  let morningReport = 'Наступило утро. Этой ночью никто не погиб!';
  if (mafiaTargetId) {
    const victim = room.players.find(p => p.id === mafiaTargetId);
    if (victim) {
      if (healedTargetId === mafiaTargetId) {
        morningReport = `Наступило утро! Ночью совершено покушение на игрока «${victim.name}», но Доктор вовремя спас его!`;
      } else {
        victim.isAlive = false;
        victim.revealedPublicly = true;
        morningReport = `Наступило утро! Ночью был убит игрок «${victim.name}» (${ROLE_NAMES[victim.role]}).`;
      }
    }
  }

  io.to(room.roomId).emit('chat:global:message', {
    system: true,
    text: morningReport
  });

  if (checkWinCondition(room)) return;

  startDayPhase(room, morningReport);
}

function startDayPhase(room, morningReport) {
  room.status = PHASES.DAY;
  room.announcement = `${morningReport} Открыто дневное обсуждение!`;

  startPhaseCountdown(room, room.settings.discussionTime, () => {
    startVotingPhase(room);
  });
}

function startVotingPhase(room) {
  room.status = PHASES.VOTING;
  room.dayVotes = {};
  room.dayVotesCount = {};
  room.announcement = 'Голосование! Выберите игрока, которого подозреваете, или воздержитесь.';

  startPhaseCountdown(room, room.settings.votingTime, () => {
    resolveVotingPhase(room);
  });
}

function resolveVotingPhase(room) {
  clearRoomTimers(room);

  let maxVotes = 0;
  let candidateId = null;
  let tie = false;

  Object.entries(room.dayVotesCount).forEach(([targetId, count]) => {
    if (count > maxVotes) {
      maxVotes = count;
      candidateId = targetId;
      tie = false;
    } else if (count === maxVotes && count > 0) {
      tie = true;
    }
  });

  let voteSummary = 'Голосование завершено. Жители не пришли к единому мнению — никто не выбывает.';

  if (candidateId && !tie && maxVotes > 0) {
    const eliminated = room.players.find(p => p.id === candidateId);
    if (eliminated) {
      eliminated.isAlive = false;
      eliminated.revealedPublicly = true;
      voteSummary = `По итогам дневного голосования город казнил игрока «${eliminated.name}». Его роль: ${ROLE_NAMES[eliminated.role]}!`;
    }
  }

  io.to(room.roomId).emit('chat:global:message', {
    system: true,
    text: voteSummary
  });

  if (checkWinCondition(room)) return;

  room.round += 1;
  startNightPhase(room);
}

// Поддержка прямых ссылок-приглашений вида /room/abc123
app.get('/room/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Сервер Мафии запущен на порту ${PORT}`);
});
