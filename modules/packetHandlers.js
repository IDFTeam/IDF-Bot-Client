const { decodeFixedString } = require('./stringUtils');
const BitStreamReader = require('./BitStreamReader');
const Base64NameEncoder = require('./Base64NameEncoder');

const READY_PROGRESS_THRESHOLD = 0;

function createRoomInfo() {
  return {
    arraySize: 0,
    progressBar: 0,
    mapId: 0,
    mapSeed: 0,
    mapType: 0,
    gameMode: 0,
    mapVariant: 0,
    difficulty: 0,
    isContest: 0,
    roomId: 0,
    spawningSeed: 0,
    lastUsedGameSlot: 0,
    bracketSeed: 0,
  };
}

function buildClanMarker(clanTag) {
  const tag = String(clanTag ?? '').trim();
  if (!tag) return null;
  return tag.startsWith('[') && tag.endsWith(']') ? tag : `[${tag}]`;
}

function hasEchoTag(playerName) {
  return String(playerName ?? '').toLowerCase().includes('[echo]');
}

function createPacketHandlers(options = {}) {
  let selfAccountId = null;
  let targetAccountId = options.targetAccountId ?? null;
  let targetAccount = options.targetAccount ?? null;
  let targetClanTag = options.targetClanTag ?? null;
  let targetClanMarker = buildClanMarker(targetClanTag);
  const botAccountIds = new Set((options.botAccountIds || []).filter(Number.isInteger));
  const botIndex = Number.isInteger(options.botIndex) ? options.botIndex : 0;
  const readyRoomIndex = Number.isInteger(options.readyRoomIndex) ? Math.max(0, Math.min(3, options.readyRoomIndex)) : 0;
  const readyStaggerMs = Number.isInteger(options.readyStaggerMs) ? Math.max(0, options.readyStaggerMs) : 100;
  const waitForContest = options.waitForContest === true;
  const verbose = options.verbose === true;
  const log = (...args) => {
    if (verbose) console.log(...args);
  };
  let readySent = false;
  let readyScheduled = false;
  let readyTimer = null;

  const slotPlayers = [[], [], [], []];
  const slotPivots = [0, 0, 0, 0];
  const roomInfos = Array.from({ length: 4 }, createRoomInfo);
  const lobbySlots = slotPlayers[0];

  function setSelfAccountId(id) {
    selfAccountId = id;
  }

  function setTargetAccount(account, accountId) {
    targetAccount = account;
    targetAccountId = accountId;
  }

  function setTargetClanTag(clanTag) {
    targetClanTag = clanTag;
    targetClanMarker = buildClanMarker(clanTag);
  }

  function resetLobbyState() {
    for (let i = 0; i < 4; i++) {
      slotPlayers[i].length = 0;
      slotPivots[i] = 0;
      Object.assign(roomInfos[i], createRoomInfo());
    }
    readySent = false;
    readyScheduled = false;
    if (readyTimer) {
      clearTimeout(readyTimer);
      readyTimer = null;
    }
  }

  function swapPlayers(arr, i, j) {
    const temp = arr[i];
    arr[i] = arr[j];
    arr[j] = temp;
  }

  function getRoomPlayers(roomIndex) {
    const arr = slotPlayers[roomIndex];
    if (!arr) {
      console.warn(`[Lobby] Unknown room index ${roomIndex}`);
      return null;
    }
    return arr;
  }

  function addPlayerToSlot(roomIndex, playerData) {
    const arr = getRoomPlayers(roomIndex);
    if (!arr) return null;

    const player = { ...playerData };
    arr.push(player);

    const selfTag = selfAccountId !== null && player.accountId === selfAccountId ? ' (self)' : '';
    log(`[Lobby] Player registered -> room=${roomIndex} index=${arr.length - 1} name="${player.name}"${selfTag}`);
    return player;
  }

  function addLobbyPlayer(playerData) {
    return addPlayerToSlot(0, playerData);
  }

  function markPlayerReady(id, roomIndex = 0) {
    const arr = getRoomPlayers(roomIndex);
    if (!arr) return;

    if (id < 0 || id >= arr.length || !arr[id]) {
      console.warn(`[Ready] No player at id=${id} room=${roomIndex} length=${arr.length} ready=${slotPivots[roomIndex]}`);
      return;
    }

    const readyCount = slotPivots[roomIndex];
    const player = arr[id];
    const playerName = player.name ?? '?';

    if (roomIndex === 2) {
      if (id >= readyCount) {
        let insertAt = readyCount;
        const elo = player.elo ?? 0;
        while (insertAt > 0 && elo > (arr[insertAt - 1]?.elo ?? -Infinity)) {
          insertAt--;
        }

        arr[id] = arr[readyCount];
        arr.splice(readyCount, 1);
        arr.splice(insertAt, 0, player);
        slotPivots[roomIndex]++;
        log(`[Ready] READIED -> room=${roomIndex} name="${playerName}" readyIndex=${insertAt}`);
        return;
      }

      arr.splice(readyCount, 0, player);
      slotPivots[roomIndex]--;
      arr.splice(id, 1);
      log(`[Ready] UNREADIED -> room=${roomIndex} name="${playerName}"`);
      return;
    }

    if (id >= readyCount) {
      swapPlayers(arr, readyCount, id);
      slotPivots[roomIndex]++;
      log(`[Ready] READIED -> room=${roomIndex} name="${playerName}" readyIndex=${readyCount}`);
      return;
    }

    slotPivots[roomIndex]--;
    swapPlayers(arr, slotPivots[roomIndex], id);
    log(`[Ready] UNREADIED -> room=${roomIndex} name="${playerName}"`);
  }

  function removePlayerFromRoom(id, roomIndex) {
    const arr = getRoomPlayers(roomIndex);
    if (!arr) return null;

    if (id < 0 || id >= arr.length || !arr[id]) {
      console.warn(`[Lobby] No player to remove at id=${id} room=${roomIndex} length=${arr.length} ready=${slotPivots[roomIndex]}`);
      return null;
    }

    const removed = arr[id];
    const lastPlayer = arr[arr.length - 1];

    if (id >= slotPivots[roomIndex]) {
      arr[id] = lastPlayer;
    } else {
      slotPivots[roomIndex]--;
      if (roomIndex === 2) {
        arr.splice(slotPivots[roomIndex] + 1, 0, lastPlayer);
        arr.splice(id, 1);
      } else {
        arr[id] = arr[slotPivots[roomIndex]];
        arr[slotPivots[roomIndex]] = lastPlayer;
      }
    }

    arr.pop();
    log(`[Lobby] Player removed -> room=${roomIndex} oldIndex=${id} name="${removed.name}"`);
    return removed;
  }

  function switchPlayerRoom(id, fromRoom, toRoom) {
    const player = removePlayerFromRoom(id, fromRoom);
    if (!player) return;

    addPlayerToSlot(toRoom, player);
    log(`[Room Switch] Player moved -> name="${player.name}" from=${fromRoom} to=${toRoom}`);
  }

  function updatePlayerInfo(id, roomIndex, info) {
    const arr = getRoomPlayers(roomIndex);
    if (!arr) return;

    const player = arr[id];
    if (!player) {
      console.warn(`[Update] Skipping unknown player at index ${id} room=${roomIndex}`);
      return;
    }

    Object.assign(player, info);
    log(`[Update] Player ${id} updated -> room=${roomIndex} name="${player.name}"`);
  }

  function getReadyPlayers() {
    return lobbySlots.slice(0, slotPivots[0]);
  }

  function getUnreadyPlayers() {
    return lobbySlots.slice(slotPivots[0]);
  }

  function hasSelfInRoom(roomIndex) {
    if (selfAccountId === null) return true;
    const players = getRoomPlayers(roomIndex);
    return players ? players.some((player) => player?.accountId === selfAccountId) : false;
  }

  function sendReadyIfNeeded(roomIndex, room, ws) {
    if (!ws) return;
    if (readySent) return;
    if (readyScheduled) return;
    if (roomIndex !== readyRoomIndex) return;
    if (room.arraySize <= READY_PROGRESS_THRESHOLD) return;
    if (waitForContest && room.isContest !== 1) return;
    if (!hasSelfInRoom(roomIndex)) {
      log(`[Ready] Waiting for self accountId=${selfAccountId} to appear in room=${roomIndex}`);
      return;
    }

    readyScheduled = true;
    const delayMs = Math.min(botIndex, 25) * readyStaggerMs;
    readyTimer = setTimeout(() => {
      readyTimer = null;
      readyScheduled = false;
      if (readySent) return;
      if (!ws || ws.readyState !== 1) return;

      readySent = true;
      ws.send(new Uint8Array([0x05, 0x00]));
      log(waitForContest
        ? `[Ready] Sent ready packet after contest room became active delay=${delayMs}ms`
        : `[Ready] Sent ready packet after room became active delay=${delayMs}ms`);
    }, delayMs);
  }

  function hasSentReady() {
    return readySent;
  }

  function decodeKeepaliveChallenge(data) {
    const reader = new BitStreamReader();
    reader.init(new Uint8Array(data));
    reader.readBits(1);
    reader.readBits(6);
    const remainingBits = reader.size * 8 - reader.bitPosition;
    const eventType = remainingBits >= 3 + 5 + 30 * 3 ? reader.readBits(3) : 0;
    const bitLength = reader.readBits(5);
    const val1 = reader.readBits(30);
    const val2 = reader.readBits(30);
    const target = reader.readBits(30);
    return { eventType, bitLength, val1, val2, target };
  }

  function handleAccountPacket(data, onAccountId) {
    const reader = new BitStreamReader();
    reader.init(new Uint8Array(data));
    reader.readBits(1);
    const opcode = reader.readBits(6);
    if (opcode !== 10) return;

    const serverAccountId = reader.readBits(30);
    const account = decodeFixedString(reader, 5);
    const password = decodeFixedString(reader, 15);
    const accountId = new Base64NameEncoder().encodeStringToInt(account, 5);

    log(`ACCOUNT: ${account} | PASSWORD: ${password} | accountId: ${accountId} | serverAccountId: ${serverAccountId}`);

    setSelfAccountId(accountId);
    if (onAccountId) onAccountId(accountId);
  }

  function decodeOpcode2(data, ws) {
    const reader = new BitStreamReader();
    reader.init(new Uint8Array(data));

    const packetType = reader.readBits(1);
    const opcode = reader.readBits(6);
    if (!(packetType === 0 && opcode === 2)) return null;

    resetLobbyState();

    const slots = [];

    for (let index = 0; index < 4; index++) {
      const room = roomInfos[index];
      room.arraySize = reader.readBits(10);
      room.progressBar = room.arraySize;
      room.mapId = reader.readBits(6);
      room.mapSeed = reader.readBits(14);
      room.mapType = reader.readBits(4);
      room.gameMode = reader.readBits(6);
      room.mapVariant = reader.readBits(14);
      room.difficulty = reader.readBits(4);
      room.isContest = reader.readBits(1);
      room.roomId = reader.readBits(12);
      room.spawningSeed = reader.readBits(14);

      const playerCount = reader.readBits(16);
      const readyPlayers = reader.readBits(16);
      slotPivots[index] = readyPlayers;

      const players = [];
      for (let j = 0; j < playerCount; j++) {
        const player = {
          accountId: reader.readBits(30),
          name: reader.decodeVarLengthString(5),
          accountType: reader.readBits(4),
          rank: reader.readBits(30),
          unknown_7b: reader.readBits(7),
          elo: reader.readBits(16),
          colorInt: reader.readBits(18),
          gold: reader.readBits(11),
          ipInt: reader.readBits(12),
        };

        addPlayerToSlot(index, player);
        players.push(player);
      }

      sendReadyIfNeeded(index, room, ws);

      if (index === 0) {
        log(`[Lobby] Initial ready count set -> ${slotPivots[0]} player(s) already ready`);
      }

      slots.push({ index, room: { ...room }, readyPlayers, playerCount, players });
    }

    if (verbose) logOpcode2(slots);
    return slots;
  }

  function logOpcode2(slots) {
    console.log('\n=== [Opcode 2] Initial Lobby State ===');
    for (const { index, room, readyPlayers, playerCount, players } of slots) {
      if (index !== 0) continue;
      console.log(`  -- Slot ${index} --`);
      console.log(`    arraySize=${room.arraySize}  mapId=${room.mapId}  mapType=${room.mapType}  mapVariant=${room.mapVariant}  gameMode=${room.gameMode}`);
      console.log(`    mapSeed=${room.mapSeed}  isContest=${room.isContest}`);
      console.log(`    roomId=${room.roomId}  spawningSeed=${room.spawningSeed}  Ready=${readyPlayers}  players=${playerCount}`);
      for (let j = 0; j < players.length; j++) {
        const p = players[j];
        console.log(`    [Player ${j}] name="${p.name}" accountId=${p.accountId}  accountType=${p.accountType}  rank=${p.rank}  unknown_7b=${p.unknown_7b}  elo=${p.elo / 10}  colorInt=${p.colorInt}  gold=${p.gold}  ipInt=${p.ipInt}`);
      }
    }
    console.log('=== End Opcode 2 ===\n');
  }

  function findPlayerIndexByAccountId(players, accountId) {
    if (accountId === null || accountId === undefined) {
      return -1;
    }

    for (let i = 0; i < players.length; i++) {
      if (players[i].accountId === accountId) {
        return i;
      }
    }

    return -1;
  }

  function findLocalPlayerIndex(players) {
    if (selfAccountId === null) {
      console.warn('[Match] Cannot find local player because selfAccountId is not set');
      return -1;
    }

    return findPlayerIndexByAccountId(players, selfAccountId);
  }

  function findTargetPlayers(players) {
    const marker = targetClanMarker ? targetClanMarker.toLowerCase() : null;
    const matches = [];
    for (let i = 0; i < players.length; i++) {
      const player = players[i];
      if (player.accountId === selfAccountId) continue;
      if (botAccountIds.has(player.accountId)) continue;
      if (hasEchoTag(player.name)) continue;
      if (marker && !String(player.name ?? '').toLowerCase().includes(marker)) continue;

      matches.push({
        originalId: i,
        player,
        clanIndex: matches.length,
      });
    }

    return matches;
  }

  function pickAssignedTarget(targets) {
    if (targets.length === 0) return null;

    const assignmentIndex = ((botIndex % targets.length) + targets.length) % targets.length;
    const target = targets[assignmentIndex];
    return {
      ...target,
      assignmentIndex,
      assignmentCount: targets.length,
    };
  }

  function tryStartMatch(roomIndex, connectUrl, aEc, mapType) {
    let readyCount = slotPivots[roomIndex];
    if (readyCount < 2) return null;

    const maxPlayers = mapType === 9 ? 333 : 512;
    readyCount = Math.min(readyCount, maxPlayers);
    if (mapType === 8) {
      readyCount -= readyCount % 2;
    }
    if (readyCount < 2) return null;

    const roomPlayers = slotPlayers[roomIndex];
    const joinedPlayers = roomPlayers.splice(0, readyCount);
    slotPivots[roomIndex] -= readyCount;

    let myId = findLocalPlayerIndex(joinedPlayers);
    if (myId === -1) {
      log(`[Match] Room ${roomIndex} started without this client (${readyCount} player(s))`);
      return null;
    }

    const targetCandidates = findTargetPlayers(joinedPlayers);
    let assignableTargets = targetCandidates;

    let gameSeed = aEc;
    if (mapType === 8) {
      const pairStart = myId - (myId % 2);
      gameSeed = (gameSeed + (myId >> 1)) % 1024;
      assignableTargets = targetCandidates.filter((target) => (
        target.originalId >= pairStart && target.originalId < pairStart + 2
      ));

      myId %= 2;
      log(`[Match] 1v1 pair selected -> pairStart=${pairStart} localPairId=${myId}`);
    }

    const assignedTarget = pickAssignedTarget(assignableTargets);
    const targetOriginalId = assignedTarget ? assignedTarget.originalId : -1;
    const targetPlayer = assignedTarget ? assignedTarget.player : null;
    const targetGameId = assignedTarget
      ? mapType === 8
        ? assignedTarget.originalId % 2
        : assignedTarget.originalId
      : null;
    const matchId = joinedPlayers.map((player) => player.accountId).join('.');

    const serverUrl = require('./../alphabot').SERVER_BY_INDEX?.[connectUrl] || `unknown(${connectUrl})`;
    log(`[joinInfo] Final myId=${myId} room=${roomIndex} joinedPlayers=${readyCount} connectUrl=${connectUrl} aEc=${gameSeed}`);

    if (targetClanMarker) {
      if (targetCandidates.length === 0) {
        log(`[TargetClan] No joined players found with ${targetClanMarker}`);
      } else if (!assignedTarget) {
        log(`[TargetClan] Found ${targetCandidates.length} player(s) with ${targetClanMarker}, but none are targetable for this bot`);
      } else {
        log(`[TargetClan] ${targetClanMarker} assignment ${assignedTarget.assignmentIndex + 1}/${assignedTarget.assignmentCount}: "${targetPlayer.name}" originalId=${targetOriginalId} gamePlayerId=${targetGameId}`);
      }
    } else if (targetCandidates.length === 0) {
      log('[TargetAll] No targetable joined players found');
    } else if (!assignedTarget) {
      log(`[TargetAll] Found ${targetCandidates.length} targetable player(s), but none are targetable for this bot`);
    } else {
      log(`[TargetAll] assignment ${assignedTarget.assignmentIndex + 1}/${assignedTarget.assignmentCount}: "${targetPlayer.name}" originalId=${targetOriginalId} gamePlayerId=${targetGameId}`);
    }

    return {
      connectUrl,
      serverUrl,
      aEc: gameSeed,
      matchId,
      myId,
      targetClanTag,
      targetClanMarker,
      targetClanPlayerCount: targetCandidates.length,
      targetAssignmentIndex: assignedTarget ? assignedTarget.assignmentIndex : null,
      targetAssignmentCount: assignedTarget ? assignedTarget.assignmentCount : assignableTargets.length,
      targetGameId,
      targetPlayer: targetPlayer
        ? {
            accountId: targetPlayer.accountId,
            name: targetPlayer.name,
            originalId: targetOriginalId,
            gameId: targetGameId,
          }
        : null,
    };
  }

  function decodeOpcode16(data, ws) {
    const reader = new BitStreamReader();
    reader.init(new Uint8Array(data));

    const packetType = reader.readBits(1);
    const opcode = reader.readBits(6);
    if (!(packetType === 0 && opcode === 16)) return null;

    const MPPlayers = reader.readBits(20);
    const SPPlayers = reader.readBits(20);
    const playerCount = reader.readBits(16);
    const players = [];

    for (let fO = 0; fO < playerCount; fO++) {
      const id = reader.readBits(3);
      const entry = { id };

      switch (id) {
        case 0:
          entry.roomIndex = reader.readBits(2);
          entry.accountId = reader.readBits(30);
          entry.name = reader.decodeVarLengthString(5);
          entry.accountType = 0;
          entry.rank = 1234566;
          entry.unknown_7b = 127;
          entry.elo = 0;
          entry.colorInt = reader.readBits(18);
          entry.gold = 0;
          entry.ipInt = reader.readBits(12);
          addPlayerToSlot(entry.roomIndex, entry);
          break;

        case 1:
          entry.playerId = reader.readBits(16);
          entry.roomIndex = reader.readBits(2);
          markPlayerReady(entry.playerId, entry.roomIndex);
          break;

        case 2:
          entry.playerId = reader.readBits(16);
          entry.roomIndex = reader.readBits(2);
          entry.switchedRoomTo = reader.readBits(2);
          switchPlayerRoom(entry.playerId, entry.roomIndex, entry.switchedRoomTo);
          break;

        case 3:
          entry.playerId = reader.readBits(16);
          entry.roomIndex = reader.readBits(2);
          removePlayerFromRoom(entry.playerId, entry.roomIndex);
          break;

        case 4:
          entry.playerId = reader.readBits(16);
          entry.roomIndex = reader.readBits(2);
          entry.accountType = reader.readBits(4);
          entry.rank = reader.readBits(30);
          entry.unknown_7b = reader.readBits(7);
          entry.elo = reader.readBits(16);
          entry.gold = reader.readBits(11);
          entry.colorInt = reader.readBits(18);
          updatePlayerInfo(entry.playerId, entry.roomIndex, {
            accountType: entry.accountType,
            rank: entry.rank,
            unknown_7b: entry.unknown_7b,
            elo: entry.elo,
            gold: entry.gold,
            colorInt: entry.colorInt,
          });
          break;

        case 5:
          entry.playerId = reader.readBits(16);
          entry.roomIndex = reader.readBits(2);
          entry.unknown_1b = reader.readBits(1);
          break;

        default:
          console.warn(`[opcode16] Unknown player entry id=${id}`);
          break;
      }

      players.push(entry);
    }

    const slots = [];
    let joinInfo = null;

    for (let index = 0; index < 4; index++) {
      const room = roomInfos[index];
      const matchMapType = room.mapType;

      room.arraySize = reader.readBits(10);
      room.progressBar = room.arraySize;
      room.gameMode = reader.readBits(6);
      room.mapVariant = reader.readBits(14);
      room.difficulty = reader.readBits(4);

      sendReadyIfNeeded(index, room, ws);

      if (room.arraySize === 0) {
        const connectUrl = reader.readBits(10);
        const aEc = reader.readBits(10);

        room.lastUsedGameSlot = connectUrl;
        room.bracketSeed = aEc;

        const maybeJoinInfo = tryStartMatch(index, connectUrl, aEc, matchMapType);
        if (!joinInfo && maybeJoinInfo) {
          joinInfo = maybeJoinInfo;
        }

        room.mapId = reader.readBits(6);
        room.mapSeed = reader.readBits(14);
        room.mapType = reader.readBits(4);
        room.isContest = reader.readBits(1);
        room.roomId = reader.readBits(12);
        room.spawningSeed = reader.readBits(14);

        slots.push({
          index,
          open: true,
          ...room,
          connectUrl,
          aEc,
          matchMapType,
        });
      } else {
        slots.push({
          index,
          open: false,
          ...room,
          matchMapType,
        });
      }
    }

    if (verbose) logOpcode16({ MPPlayers, SPPlayers, playerCount, players, slots });
    return joinInfo;
  }

  function logOpcode16({ MPPlayers, SPPlayers, playerCount, players, slots }) {
    console.log('\n=== [Opcode 16] Lobby Info ===');
    console.log(`  in MP   : ${MPPlayers}`);
    console.log(`  in SP   : ${SPPlayers}`);
    console.log(`  Players : ${playerCount}`);

    if (players.length > 0) {
      console.log('  -- Player Updates --');
      players.forEach((p, i) => {
        const parts = Object.entries(p).map(([k, v]) => `${k}=${v}`).join('  ');
        console.log(`    [${i}] ${parts}`);
      });
    }

    console.log('  -- Slots --');
    slots.forEach((s) => {
      if (!s.open) {
        console.log(`    [Slot ${s.index}] ACTIVE arraySize=${s.arraySize} gameMode=${s.gameMode} nextMapVariant=${s.mapVariant} difficulty=${s.difficulty}`);
      } else {
        console.log(`    [Slot ${s.index}] OPEN`);
        console.log(`      connectUrl = ${s.connectUrl} -> ${require('./../alphabot').SERVER_BY_INDEX?.[s.connectUrl]}`);
        console.log(`      aEc         = ${s.aEc}`);
        console.log(`      previous mapType=${s.matchMapType}  next mapId=${s.mapId}  next mapType=${s.mapType}`);
        console.log(`      mapSeed=${s.mapSeed}  isContest=${s.isContest}  roomId=${s.roomId}`);
      }
    });

    console.log('  -- Lobby Slots --');
    lobbySlots.forEach((p, i) => {
      const status = i < slotPivots[0] ? 'READY  ' : 'unready';
      console.log(`    [${i}] ${status}  name="${p.name}"  accountId=${p.accountId ?? '?'}`);
    });
    console.log(`  ready=${slotPivots[0]}  unready=${lobbySlots.length - slotPivots[0]}`);
    console.log('=== End Opcode 16 ===\n');
  }

  return {
    setSelfAccountId,
    setTargetAccount,
    setTargetClanTag,
    handleAccountPacket,
    decodeOpcode2,
    logOpcode2,
    decodeOpcode16,
    logOpcode16,
    decodeKeepaliveChallenge,
    hasSentReady,
    getReadyPlayers,
    getUnreadyPlayers,
  };
}

const defaultHandlers = createPacketHandlers();

module.exports = {
  createPacketHandlers,
  ...defaultHandlers,
};
