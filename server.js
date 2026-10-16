const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');

const uuidv4 = () => crypto.randomUUID();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
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
  KAMIKAZE_REVENGE: 'KAMIKAZE_REVENGE',
  GAME_OVER: 'GAME_OVER'
};

// Конфигурация фракций по умолчанию
const ROLE_FACTIONS = {
  civilian: 'RED',
  lucky: 'RED',
  commissar: 'RED',
  doctor: 'RED',
  hooker: 'RED',
  hobo: 'RED',
  journalist: 'RED',
  mafia: 'BLACK',
  don: 'BLACK',
  instigator: 'BLACK',
  kamikaze: 'BLACK', // Может настраиваться хостом (RED или BLACK)
  suicider: 'NEUTRAL',
  necromancer: 'NEUTRAL',
  puppeteer: 'NEUTRAL',
  mirror: 'RED', // До смерти донора считается мирным
  cultist: 'CULT'
};

io.on('connection', (socket) => {
  // 1. Создание комнаты
  socket.on('room:create', ({ playerName }, callback) => {
    const roomId = uuidv4().substring(0, 6).toUpperCase();
    const room = {
      roomId,
      hostId: socket.id,
      status: PHASES.LOBBY,
      round: 0,
      settings: {
        deck: {
          civilian: 1,
          lucky: 1,
          commissar: 1,
          doctor: 1,
          hooker: 0,
          hobo: 0,
          journalist: 1,
          kamikaze: 1,
          mafia: 1,
          don: 1,
          instigator: 0,
          suicider: 1,
          necromancer: 0,
          cultist: 0,
          puppeteer: 0,
          mirror: 0
        },
        kamikazeFaction: 'BLACK', // 'RED' или 'BLACK'
        discussionTime: 60,
        nightActionTime: 35,
        votingTime: 30
      },
      players: [{
        id: socket.id,
        name: playerName,
        role: null,
        originalRole: null,
        faction: null,
        isAlive: true,
        isHost: true,
        hasRevealedCard: false,
        isCultMember: false,
        hasUsedInstigator: false,
        mirrorDonorId: null,
        awaitingLastWords: false
      }],
      phaseTimer: null,
      nightActions: {},
      dayVotes: {},
      pendingNightDeaths: [],
      kamikazeActorId: null,
      winner: null
    };

    rooms.set(roomId, room);
    socket.join(roomId);
    callback({ success: true, roomId, room });
  });

  // 2. Вход в комнату
  socket.on('room:join', ({ roomId, playerName }, callback) => {
    const cleanId = (roomId || '').trim().toUpperCase();
    const room = rooms.get(cleanId);
    if (!room) return callback({ success: false, message: 'Комната не найдена' });
    if (room.status !== PHASES.LOBBY) return callback({ success: false, message: 'Игра уже началась' });

    const existing = room.players.find(p => p.id === socket.id);
    if (!existing) {
      room.players.push({
        id: socket.id,
        name: playerName,
        role: null,
        originalRole: null,
        faction: null,
        isAlive: true,
        isHost: false,
        hasRevealedCard: false,
        isCultMember: false,
        hasUsedInstigator: false,
        mirrorDonorId: null,
        awaitingLastWords: false
      });
    }

    socket.join(cleanId);
    io.to(cleanId).emit('room:update', room);
    callback({ success: true, room });
  });

  // 3. Обновление настроек колоды хостом
  socket.on('room:update_settings', ({ roomId, deck, kamikazeFaction }) => {
    const room = rooms.get(roomId);
    if (room && room.hostId === socket.id && room.status === PHASES.LOBBY) {
      if (deck) room.settings.deck = deck;
      if (kamikazeFaction) room.settings.kamikazeFaction = kamikazeFaction;
      io.to(roomId).emit('room:update', room);
    }
  });

  // 4. Старт игры
  socket.on('game:start', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.hostId !== socket.id) return;

    const totalCards = Object.values(room.settings.deck).reduce((a, b) => a + b, 0);
    if (totalCards !== room.players.length) {
      return socket.emit('game:error', `Сумма ролей в колоде (${totalCards}) должна совпадать с числом игроков (${room.players.length})!`);
    }

    let rolesPool = [];
    for (const [role, count] of Object.entries(room.settings.deck)) {
      for (let i = 0; i < count; i++) rolesPool.push(role);
    }
    rolesPool = rolesPool.sort(() => Math.random() - 0.5);

    room.round = 1;
    room.players.forEach((player, idx) => {
      const assignedRole = rolesPool[idx];
      player.role = assignedRole;
      player.originalRole = assignedRole;
      player.faction = assignedRole === 'kamikaze' ? room.settings.kamikazeFaction : ROLE_FACTIONS[assignedRole];
      player.isAlive = true;
      player.hasRevealedCard = false;
      player.isCultMember = assignedRole === 'cultist';
      player.hasUsedInstigator = false;
      player.mirrorDonorId = null;
      player.awaitingLastWords = false;
    });

    room.status = PHASES.ROLE_REVEAL;
    io.to(roomId).emit('game:started', room);
    sendSystemChat(roomId, '🃏 Партия началась! Игроки вскрывают свои карточки ролей.');
  });

  // 5. Вскрытие карты
  socket.on('player:reveal_card', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (player) player.hasRevealedCard = true;
    io.to(roomId).emit('room:update', room);

    if (room.players.every(p => p.hasRevealedCard)) {
      room.status = PHASES.FIRST_NIGHT_INTRO;

      const mafiaTeam = room.players
        .filter(p => p.faction === 'BLACK')
        .map(p => ({ id: p.id, name: p.name, role: p.role }));

      room.players.forEach(p => {
        if (p.faction === 'BLACK') {
          io.to(p.id).emit('mafia:acquaintance', mafiaTeam);
        }
      });

      io.to(roomId).emit('game:phase_change', {
        status: room.status,
        round: room.round,
        timeLeft: 8,
        message: 'Город засыпает... Мафия знакомится друг с другом.'
      });

      clearTimeout(room.phaseTimer);
      room.phaseTimer = setTimeout(() => startNightPhase(roomId), 8000);
    }
  });

  // 6. Общий чат (доступен в лобби и днем только для живых)
  socket.on('chat:global', ({ roomId, message }) => {
    const room = rooms.get(roomId);
    if (!room || !message?.trim()) return;
    if (![PHASES.LOBBY, PHASES.DAY, PHASES.VOTING].includes(room.status)) return;

    const sender = room.players.find(p => p.id === socket.id);
    if (!sender || (!sender.isAlive && room.status !== PHASES.LOBBY)) return;

    io.to(roomId).emit('chat:global:message', {
      id: uuidv4(),
      senderName: sender.name,
      message: message.trim(),
      type: 'normal'
    });
  });

  // 7. Ночной чат мафии
  socket.on('chat:mafia', ({ roomId, message }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== PHASES.NIGHT || !message?.trim()) return;

    const sender = room.players.find(p => p.id === socket.id);
    if (sender && sender.faction === 'BLACK' && sender.isAlive) {
      room.players.forEach(p => {
        if (p.faction === 'BLACK') {
          io.to(p.id).emit('chat:mafia:message', {
            senderName: sender.name,
            role: sender.role,
            message: message.trim()
          });
        }
      });
    }
  });

  // 8. Отправка предсмертного сообщения убитым ночью игроком
  socket.on('player:last_words', ({ roomId, message }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== PHASES.MORNING_LAST_WORDS) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.awaitingLastWords) return;

    player.awaitingLastWords = false;
    if (message && message.trim()) {
      io.to(roomId).emit('chat:global:message', {
        id: uuidv4(),
        senderName: player.name,
        message: message.trim(),
        type: 'last_words'
      });
    }

    // Если все убитые за ночь отправили последнее слово, сразу переходим ко Дню
    if (!room.players.some(p => p.awaitingLastWords)) {
      clearTimeout(room.phaseTimer);
      proceedAfterMorning(roomId);
    }
  });

  // 9. Ночные действия всех ролей
  socket.on('night:action', ({ roomId, targetId, secondTargetId }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== PHASES.NIGHT) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.isAlive) return;

    room.nightActions[player.id] = {
      actorId: player.id,
      role: player.role,
      targetId,
      secondTargetId: secondTargetId || null
    };

    // Если Зеркало выбирает донора в первую ночь
    if (player.role === 'mirror' && room.round === 1 && targetId) {
      player.mirrorDonorId = targetId;
    }

    socket.emit('night:action_confirmed', { role: player.role, targetId, secondTargetId });
  });

  // 10. Дневное голосование
  socket.on('day:vote', ({ roomId, targetId }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== PHASES.VOTING) return;

    const voter = room.players.find(p => p.id === socket.id);
    if (!voter || !voter.isAlive) return;

    room.dayVotes[voter.id] = targetId;
    io.to(roomId).emit('day:vote_update', { voterName: voter.name, targetId });
  });

  // 11. Выстрел Камикадзе перед казнью
  socket.on('kamikaze:shoot', ({ roomId, targetId }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== PHASES.KAMIKAZE_REVENGE) return;
    if (socket.id !== room.kamikazeActorId) return;

    clearTimeout(room.phaseTimer);
    executeKamikazeRevenge(roomId, targetId);
  });

  socket.on('disconnect', () => {
    // Очистка пустых комнат
    for (const [roomId, room] of rooms.entries()) {
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1 && room.status === PHASES.LOBBY) {
        room.players.splice(idx, 1);
        if (room.players.length === 0) {
          rooms.delete(roomId);
        } else {
          if (room.hostId === socket.id) room.hostId = room.players[0].id;
          io.to(roomId).emit('room:update', room);
        }
      }
    }
  });
});

function sendSystemChat(roomId, text) {
  io.to(roomId).emit('chat:global:message', {
    id: uuidv4(),
    senderName: 'Ведущий',
    message: text,
    type: 'system'
  });
}

// Запуск Ночи
function startNightPhase(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (checkWinConditions(roomId)) return;

  room.status = PHASES.NIGHT;
  room.nightActions = {};

  io.to(roomId).emit('room:update', room);
  io.to(roomId).emit('game:phase_change', {
    status: PHASES.NIGHT,
    round: room.round,
    timeLeft: room.settings.nightActionTime,
    message: `Ночь ${room.round}. Город спит, активные роли делают свой выбор.`
  });

  clearTimeout(room.phaseTimer);
  room.phaseTimer = setTimeout(() => {
    resolveNight(roomId);
  }, room.settings.nightActionTime * 1000);
}

// Резолюция всех ночных действий
function resolveNight(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const actions = { ...room.nightActions };
  const visits = {};
  const registerVisit = (targetId, visitorName) => {
    if (!targetId) return;
    if (!visits[targetId]) visits[targetId] = [];
    visits[targetId].push(visitorName);
  };

  // 1. Блокировка Любовницей (Путаной)
  const blockedPlayerIds = new Set();
  Object.values(actions).forEach(act => {
    if (act.role === 'hooker' && act.targetId) {
      blockedPlayerIds.add(act.targetId);
      const hookerPlayer = room.players.find(p => p.id === act.actorId);
      if (hookerPlayer) registerVisit(act.targetId, hookerPlayer.name);
    }
  });

  // 2. Кукловод (перенаправление хода одного игрока на другого)
  Object.values(actions).forEach(act => {
    if (act.role === 'puppeteer' && !blockedPlayerIds.has(act.actorId)) {
      const puppetId = act.targetId;
      const newDestId = act.secondTargetId;
      if (puppetId && newDestId && actions[puppetId]) {
        actions[puppetId].targetId = newDestId;
        io.to(puppetId).emit('personal:alert', '🎭 Кукловод перехватил управление вашими руками этой ночью!');
      }
    }
  });

  // 3. Некромант (использование способности мертвого игрока)
  let necromancerKillTarget = null;
  let necromancerHealTarget = null;
  Object.values(actions).forEach(act => {
    if (act.role === 'necromancer' && !blockedPlayerIds.has(act.actorId)) {
      const deadPlayer = room.players.find(p => p.id === act.targetId && !p.isAlive);
      const livingTarget = room.players.find(p => p.id === act.secondTargetId && p.isAlive);
      const necroPlayer = room.players.find(p => p.id === act.actorId);

      if (deadPlayer && livingTarget && necroPlayer) {
        registerVisit(livingTarget.id, necroPlayer.name);
        if (['mafia', 'don', 'kamikaze'].includes(deadPlayer.role)) {
          necromancerKillTarget = livingTarget.id;
        } else if (deadPlayer.role === 'doctor') {
          necromancerHealTarget = livingTarget.id;
        } else if (deadPlayer.role === 'hooker') {
          blockedPlayerIds.add(livingTarget.id);
        } else if (deadPlayer.role === 'commissar') {
          const isBlack = livingTarget.faction === 'BLACK';
          io.to(necroPlayer.id).emit('personal:alert', `💀 Дух Шерифа проверил ${livingTarget.name}: ${isBlack ? 'МАФИЯ' : 'НЕ МАФИЯ'}`);
        }
      }
    }
  });

  // 4. Подстрекатель (одноразовый подброс улик)
  let framedPlayerId = null;
  Object.values(actions).forEach(act => {
    if (act.role === 'instigator' && !blockedPlayerIds.has(act.actorId)) {
      const instPlayer = room.players.find(p => p.id === act.actorId);
      if (instPlayer && !instPlayer.hasUsedInstigator && act.targetId) {
        framedPlayerId = act.targetId;
        instPlayer.hasUsedInstigator = true;
        registerVisit(act.targetId, instPlayer.name);
      }
    }
  });

  // 5. Выстрел Мафии и Дона
  const mafiaVotes = {};
  Object.values(actions).forEach(act => {
    if (['mafia', 'don'].includes(act.role) && !blockedPlayerIds.has(act.actorId) && act.targetId) {
      mafiaVotes[act.targetId] = (mafiaVotes[act.targetId] || 0) + 1;
      const shooter = room.players.find(p => p.id === act.actorId);
      if (shooter) registerVisit(act.targetId, shooter.name);
    }
  });

  let mafiaKillTarget = Object.keys(mafiaVotes).reduce((a, b) => mafiaVotes[a] > mafiaVotes[b] ? a : b, null);

  // 6. Лечение Доктора
  const healedTargets = new Set();
  if (necromancerHealTarget) healedTargets.add(necromancerHealTarget);

  Object.values(actions).forEach(act => {
    if (act.role === 'doctor' && !blockedPlayerIds.has(act.actorId) && act.targetId) {
      const docPlayer = room.players.find(p => p.id === act.actorId);
      if (docPlayer && docPlayer.lastDoctorTarget !== act.targetId) {
        healedTargets.add(act.targetId);
        docPlayer.lastDoctorTarget = act.targetId;
        registerVisit(act.targetId, docPlayer.name);
      } else if (docPlayer) {
        docPlayer.lastDoctorTarget = null;
      }
    }
  });

  // 7. Расчет смертей и проверка «Счастливчика» (50% шанс выживания)
  const killedIds = new Set();
  let luckySurvivedMessage = null;

  if (mafiaKillTarget && !healedTargets.has(mafiaKillTarget)) {
    const victim = room.players.find(p => p.id === mafiaKillTarget);
    if (victim) {
      if (victim.role === 'lucky' && Math.random() < 0.5) {
        luckySurvivedMessage = '🍀 Ночью мафия стреляла в Счастливчика, но пуля прошла по касательной — он чудом выжил!';
        io.to(victim.id).emit('personal:alert', '🍀 В вас стреляла мафия, но ваша пассивная Удача спасла вам жизнь!');
      } else {
        killedIds.add(mafiaKillTarget);
      }
    }
  }

  if (necromancerKillTarget && !healedTargets.has(necromancerKillTarget)) {
    killedIds.add(necromancerKillTarget);
  }

  // 8. Вербовка Сектанта (Проповедника)
  Object.values(actions).forEach(act => {
    if (act.role === 'cultist' && !blockedPlayerIds.has(act.actorId) && !killedIds.has(act.actorId) && act.targetId) {
      const target = room.players.find(p => p.id === act.targetId);
      const cultLeader = room.players.find(p => p.id === act.actorId);
      if (target && target.isAlive && !killedIds.has(target.id)) {
        target.isCultMember = true;
        if (cultLeader) registerVisit(target.id, cultLeader.name);
        io.to(target.id).emit('personal:alert', '🕯️ Проповедник обратил вас в тайный культ Сектантов!');
      }
    }
  });

  // 9. Проверки Комиссара, Дона, Журналиста и Бомжа
  Object.values(actions).forEach(act => {
    const actor = room.players.find(p => p.id === act.actorId);
    if (!actor || blockedPlayerIds.has(actor.id)) return;

    // Комиссар
    if (act.role === 'commissar' && act.targetId) {
      const target = room.players.find(p => p.id === act.targetId);
      if (target) {
        registerVisit(target.id, actor.name);
        const isBlack = target.faction === 'BLACK' || target.id === framedPlayerId;
        io.to(actor.id).emit('personal:alert', `🕵️ Проверка Комиссара: ${target.name} — ${isBlack ? 'ЧЕРНЫЙ (Мафия / Подставлен)' : 'КРАСНЫЙ (Мирный)'}`);
      }
    }

    // Дон ищет Комиссара
    if (act.role === 'don' && act.secondTargetId) {
      const checkTarget = room.players.find(p => p.id === act.secondTargetId);
      if (checkTarget) {
        const isComm = checkTarget.role === 'commissar';
        io.to(actor.id).emit('personal:alert', `🎩 Проверка Дона: ${checkTarget.name} — ${isComm ? 'КОМИССАР!' : 'Не Комиссар'}`);
      }
    }

    // Журналист сверяет фракции двух игроков
    if (act.role === 'journalist' && act.targetId && act.secondTargetId) {
      const p1 = room.players.find(p => p.id === act.targetId);
      const p2 = room.players.find(p => p.id === act.secondTargetId);
      if (p1 && p2) {
        registerVisit(p1.id, actor.name);
        registerVisit(p2.id, actor.name);
        const f1 = getEffectiveFactionForJournalist(p1, framedPlayerId);
        const f2 = getEffectiveFactionForJournalist(p2, framedPlayerId);
        const same = f1 === f2;
        io.to(actor.id).emit('personal:alert', `📰 Расследование Журналиста: ${p1.name} и ${p2.name} играют за ${same ? 'ОДНУ фракцию' : 'РАЗНЫЕ фракции'}!`);
      }
    }

    // Бомж следит за гостями
    if (act.role === 'hobo' && act.targetId) {
      const target = room.players.find(p => p.id === act.targetId);
      if (target) {
        const guests = (visits[target.id] || []).filter(name => name !== actor.name);
        io.to(actor.id).emit('personal:alert', `🍾 Бомж проследил за ${target.name}. Гости этой ночью: ${guests.length ? guests.join(', ') : 'никто не приходил'}.`);
      }
    }
  });

  // Применяем ночные смерти
  const deadNames = [];
  room.pendingNightDeaths = [];

  killedIds.forEach(id => {
    const victim = room.players.find(p => p.id === id);
    if (victim && victim.isAlive) {
      victim.isAlive = false;
      victim.awaitingLastWords = true;
      deadNames.push(victim.name);
      room.pendingNightDeaths.push(victim.id);

      // Отправляем убитому игроку сигнал для включения хоррор-эффекта и окна предсмертной записки
      io.to(victim.id).emit('player:you_died', {
        reason: 'Ночное покушение',
        timeForLastWords: 20
      });

      // Если убили Сектанта — культ распадается
      if (victim.role === 'cultist') {
        room.players.forEach(p => { p.isCultMember = false; });
        sendSystemChat(roomId, '🕯️ Проповедник погиб! Тайный культ сектантов распался.');
      }
    }
  });

  // Проверяем трансформацию Зеркала (Хамелеона)
  checkMirrorTransformations(room);

  // Рассылаем актуальный состав секты выжившим сектантам
  broadcastCultUpdate(room);

  if (luckySurvivedMessage) {
    sendSystemChat(roomId, luckySurvivedMessage);
  }

  if (deadNames.length > 0) {
    room.status = PHASES.MORNING_LAST_WORDS;
    sendSystemChat(roomId, `🌅 Наступает утро. Этой ночью погибли: ${deadNames.join(', ')}. Ожидаем их предсмертное послание (20 сек)...`);
    io.to(roomId).emit('room:update', room);
    io.to(roomId).emit('game:phase_change', {
      status: PHASES.MORNING_LAST_WORDS,
      round: room.round,
      timeLeft: 20,
      message: `Убиты: ${deadNames.join(', ')}. Они оставляют предсмертную записку...`
    });

    clearTimeout(room.phaseTimer);
    room.phaseTimer = setTimeout(() => {
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
  if (player.faction === 'RED') return 'RED';
  if (player.faction === 'BLACK') return 'BLACK';
  if (player.faction === 'CULT') return 'CULT';
  // Нейтралы-одиночки не совпадают ни с мафией, ни друг с другом
  return `SOLO_${player.id}`;
}

function checkMirrorTransformations(room) {
  room.players.forEach(player => {
    if (player.isAlive && player.role === 'mirror' && player.mirrorDonorId) {
      const donor = room.players.find(p => p.id === player.mirrorDonorId);
      if (donor && !donor.isAlive) {
        player.role = donor.originalRole;
        player.faction = donor.faction;
        io.to(player.id).emit('mirror:transformed', {
          newRole: player.role,
          newFaction: player.faction,
          donorName: donor.name
        });
      }
    }
  });
}

function broadcastCultUpdate(room) {
  const cultMembers = room.players.filter(p => p.isAlive && p.isCultMember).map(p => p.name);
  room.players.forEach(p => {
    if (p.isAlive && p.isCultMember) {
      io.to(p.id).emit('cult:update', cultMembers);
    }
  });
}

function proceedAfterMorning(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (checkWinConditions(roomId)) return;

  room.status = PHASES.DAY;
  io.to(roomId).emit('room:update', room);
  io.to(roomId).emit('game:phase_change', {
    status: PHASES.DAY,
    round: room.round,
    timeLeft: room.settings.discussionTime,
    message: `День ${room.round}. Обсуждение в общем чате!`
  });

  clearTimeout(room.phaseTimer);
  room.phaseTimer = setTimeout(() => {
    startVotingPhase(roomId);
  }, room.settings.discussionTime * 1000);
}

function startVotingPhase(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.status = PHASES.VOTING;
  room.dayVotes = {};
  sendSystemChat(roomId, '⚖️ Началось дневное голосование! Выберите кандидата на изгнание.');
  io.to(roomId).emit('room:update', room);
  io.to(roomId).emit('game:phase_change', {
    status: PHASES.VOTING,
    round: room.round,
    timeLeft: room.settings.votingTime,
    message: 'Голосование за изгнание подозреваемого!'
  });

  clearTimeout(room.phaseTimer);
  room.phaseTimer = setTimeout(() => {
    resolveDayVoting(roomId);
  }, room.settings.votingTime * 1000);
}

function resolveDayVoting(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const counts = {};
  Object.values(room.dayVotes).forEach(targetId => {
    if (targetId) counts[targetId] = (counts[targetId] || 0) + 1;
  });

  let maxVotes = 0;
  let executedId = null;
  let tie = false;

  for (const [candidateId, count] of Object.entries(counts)) {
    if (count > maxVotes) {
      maxVotes = count;
      executedId = candidateId;
      tie = false;
    } else if (count === maxVotes) {
      tie = true;
    }
  }

  if (!executedId || tie) {
    sendSystemChat(roomId, '⚖️ Голоса разделились или никто не проголосовал. Сегодня никто не казнен.');
    room.round += 1;
    startNightPhase(roomId);
    return;
  }

  const executed = room.players.find(p => p.id === executedId);
  if (!executed) {
    room.round += 1;
    startNightPhase(roomId);
    return;
  }

  executed.isAlive = false;
  sendSystemChat(roomId, `🔨 По решению города казнен ${executed.name}. Его роль была: ${executed.role.toUpperCase()}!`);

  if (executed.role === 'cultist') {
    room.players.forEach(p => { p.isCultMember = false; });
    sendSystemChat(roomId, '🕯️ Казненный оказался Проповедником! Секта распалась.');
  }

  // Проверка сольной победы Самоубийцы
  if (executed.role === 'suicider') {
    room.status = PHASES.GAME_OVER;
    room.winner = `🃏 САМОУБИЙЦА (${executed.name}) одержал сольную победу, добившись собственной казни днем!`;
    sendSystemChat(roomId, room.winner);
    io.to(roomId).emit('room:update', room);
    io.to(roomId).emit('game:over', { winner: room.winner });
    return;
  }

  checkMirrorTransformations(room);

  // Проверка способности Камикадзе («Последнее слово» — забрать одного с собой)
  if (executed.role === 'kamikaze') {
    const aliveTargets = room.players.filter(p => p.isAlive);
    if (aliveTargets.length > 0) {
      room.status = PHASES.KAMIKAZE_REVENGE;
      room.kamikazeActorId = executed.id;
      sendSystemChat(roomId, `💣 ${executed.name} оказался КАМИКАДЗЕ! У него есть 15 секунд, чтобы утащить одного игрока за собой в могилу!`);
      io.to(roomId).emit('room:update', room);
      io.to(roomId).emit('game:phase_change', {
        status: PHASES.KAMIKAZE_REVENGE,
        round: room.round,
        timeLeft: 15,
        message: `Камикадзе ${executed.name} выбирает, кого взорвать вместе с собой!`
      });

      clearTimeout(room.phaseTimer);
      room.phaseTimer = setTimeout(() => {
        const randomVictim = aliveTargets[Math.floor(Math.random() * aliveTargets.length)];
        executeKamikazeRevenge(roomId, randomVictim.id);
      }, 15000);
      return;
    }
  }

  if (!checkWinConditions(roomId)) {
    room.round += 1;
    startNightPhase(roomId);
  }
}

function executeKamikazeRevenge(roomId, targetId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const victim = room.players.find(p => p.id === targetId && p.isAlive);
  if (victim) {
    victim.isAlive = false;
    sendSystemChat(roomId, `💥 КАМИКАДЗЕ подорвал вместе с собой игрока ${victim.name} (роль: ${victim.role.toUpperCase()})!`);
    io.to(victim.id).emit('player:you_died', {
      reason: 'Взрыв Камикадзе на дневном голосовании',
      timeForLastWords: 0
    });
  }

  room.kamikazeActorId = null;
  checkMirrorTransformations(room);

  if (!checkWinConditions(roomId)) {
    room.round += 1;
    startNightPhase(roomId);
  }
}

// Проверка условий победы всех фракций
function checkWinConditions(roomId) {
  const room = rooms.get(roomId);
  if (!room) return false;

  const alive = room.players.filter(p => p.isAlive);
  const aliveBlack = alive.filter(p => p.faction === 'BLACK');
  const aliveNecro = alive.filter(p => p.role === 'necromancer');
  const aliveCultLeader = alive.some(p => p.role === 'cultist');

  let winnerText = null;

  if (alive.length === 0) {
    winnerText = '💀 Все жители города погибли. Ничья!';
  } else if (alive.length === 1 && aliveNecro.length === 1) {
    winnerText = `🔮 НЕКРОМАНТ (${aliveNecro[0].name}) остался последним выжившим и захватил власть над городом!`;
  } else if (aliveCultLeader && alive.length > 1 && alive.every(p => p.isCultMember)) {
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
    io.to(roomId).emit('room:update', room);
    io.to(roomId).emit('game:over', { winner: winnerText });
    return true;
  }

  return false;
}

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
