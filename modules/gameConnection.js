const WebSocket = require('ws');
const { sendPacket } = require('./utils');
const BitStreamReader = require('./BitStreamReader');
const { createGameCommandTracker } = require('./gameCommandTracker');
const {
  solveChallenge,
  solveExecutableChallenge,
} = require('./challengeUtils');

const {
  buildInitPacket,
  buildChallengeResponsePacket,
  buildExecutableChallengeResponse,
  buildGamePacket,
  buildSpawnPacket,
  buildAttackPacket,
  buildDonationPacket,
} = require('./packetBuilders');

const LOG_GAME_PACKETS = process.env.VERBOSE_LOGS === '1';
const TARGET_SPAWN_DELAY_MS = 15600;
const TARGET_CACHE_DECODE_WINDOW_MS = 60000;
const POST_SPAWN_NEUTRAL_ATTACK_DELAY_MS = 1000;
const TARGET_ATTACK_INTERVAL_MS = 0;
const MULTI_BACKLINE_INTERVAL_MS = 5555;
const NEUTRAL_ATTACK_UNIT_RATIO = 307;
const NEUTRAL_LAND_TARGET_PLAYER = 512;
const TARGET_ATTACK_UNIT_RATIO = 1023;
const gameGroups = new Map();

function logVerbose(...args) {
  if (LOG_GAME_PACKETS) console.log(...args);
}

function debugGame(session, ...args) {
  if (LOG_GAME_PACKETS || session?.verboseLogs) {
    console.log(...args);
  }
}

function getGameGroup(joinInfo, session) {
  const key = `${joinInfo.serverUrl}|${joinInfo.aEc}`;
  let group = gameGroups.get(key);
  if (!group) {
    group = {
      key,
      reader: null,
      gameCommandTracker: null,
      members: new Set(),
      targetTilesByPlayerId: new Map(),
    };
    gameGroups.set(key, group);
  }
  return group;
}

function registerGameConnection(joinInfo, session, gameWs, targetSpawn) {
  const group = getGameGroup(joinInfo, session);
  if (!group.gameCommandTracker) {
    group.gameCommandTracker = createGameCommandTracker({
      label: session.label || 'Game',
      logCommands: process.env.LOG_GAME_COMMANDS === '1',
    });
  }

  const member = {
    group,
    gameWs,
    targetSpawn,
    label: session.label || 'Game',
    gameState: session.gameState ?? null,
    multiBackline: session.multiBackline === true,
    multiBacklineInterval: null,
    tickDonoTimer: null,
    myId: joinInfo.myId,
    firstPostJoinPacketSeen: false,
    firstPostJoinPacketDecoded: false,
    targetSpawnSent: false,
    targetCacheDecodeUntil: 0,
    targetSpawnDelayElapsed: false,
    targetSpawnDelayTimer: null,
    neutralAttackTimer: null,
    targetAttackInterval: null,
    neutralAttackPacket: null,
    targetAttackPacket: null,
    attackSequenceStarted: false,
  };

  group.members.add(member);
  promoteReader(group);
  return member;
}

function unregisterGameConnection(member) {
  if (!member) return;

  const { group } = member;
  if (member.targetSpawnDelayTimer) {
    clearTimeout(member.targetSpawnDelayTimer);
    member.targetSpawnDelayTimer = null;
  }
  if (member.neutralAttackTimer) {
    clearTimeout(member.neutralAttackTimer);
    member.neutralAttackTimer = null;
  }
  if (member.targetAttackInterval) {
    clearInterval(member.targetAttackInterval);
    member.targetAttackInterval = null;
  }
  if (member.multiBacklineInterval) {
    member.multiBacklineInterval.cancel();
    member.multiBacklineInterval = null;
  }
  if (member.tickDonoTimer) {
    clearInterval(member.tickDonoTimer);
    member.tickDonoTimer = null;
  }

  group.members.delete(member);
  if (group.reader === member) {
    group.reader = null;
    promoteReader(group);
  }

  if (group.members.size === 0) {
    gameGroups.delete(group.key);
  }
}

function promoteReader(group) {
  if (group.reader) return;

  for (const member of group.members) {
    if (member.targetSpawn.playerId !== null && member.gameWs.readyState === WebSocket.OPEN) {
      group.reader = member;
      logVerbose(`[GameReader] ${member.label} is decoding game packets for ${group.members.size} connection(s)`);
      return;
    }
  }
}

function isGameReader(member) {
  return member && member.group.reader === member;
}

function findBorderingIds(myCells, allBorders, offsets, myId) {
  const cellSet = new Set(myCells);
  const neighbors = new Set();

  for (let i = 0; i < allBorders.length; i++) {
    if (i === myId || !allBorders[i]) continue;

    for (const c of allBorders[i]) {
      for (const offset of offsets) {
        if (cellSet.has(c - offset)) {
          neighbors.add(i);
          break;
        }
      }
    }
  }

  return [...neighbors];
}

function selectTargets(borderIds, troopData, landData, threshold = 0.6) {
  const targets = [];

  for (const id of borderIds) {
    const troops = troopData[id];
    const land = landData[id];

    if (!troops || !land) continue;

    const ratio = troops / land;

    if (ratio < threshold) {
      targets.push({ id, land });
    }
  }

  return targets.sort((a, b) => b.land - a.land);
}

async function attackCycle(state) {
  const {
    myId,
    borders,
    troopData,
    landData,
    offsets,
    attackPercent,
    gameWs,
  } = state;

  if (!gameWs || gameWs.readyState !== WebSocket.OPEN) return;

  const myCells = borders[myId] || [];
  if (myCells.length === 0) return;

  const borderIds = findBorderingIds(myCells, borders, offsets, myId);
  const attackedIds = new Set();

  function getWeakTargets(excludeIds) {
    const targets = [];
    for (const id of borderIds) {
      if (excludeIds && excludeIds.has(id)) continue;
      const troops = troopData[id];
      const land = landData[id];
      if (troops == null || land == null || land <= 0) continue;
      if (troops / land < 0.6) targets.push({ id, land });
    }
    return targets.sort((a, b) => b.land - a.land);
  }

  async function sendBatch(targets) {
    for (const t of targets) {
      if (gameWs.readyState !== WebSocket.OPEN) return;
      gameWs.send(buildAttackPacket(attackPercent, t.id));
      attackedIds.add(t.id);
      await new Promise(r => setTimeout(r, 1));
    }
  }

  // Batch 1 — attack all weak bordering enemies immediately
  await sendBatch(getWeakTargets(null));

  // Batch 2 — 1s later, attack any that were missed
  await new Promise(r => setTimeout(r, 1000));
  if (gameWs.readyState !== WebSocket.OPEN) return;
  await sendBatch(getWeakTargets(attackedIds));
}

const GBv4_OPENING = [
  { delay: 3853,  percent: 20.840950     },
  { delay: 5018,  percent: 17.733089     },
  { delay: 9704,  percent: 0.080450523   },
  { delay: 10124, percent: 37.56694721   },
  { delay: 14850, percent: 15.42917325   },
  { delay: 15650, percent: 41.50308469   },
  { delay: 19575, percent: 29.56930872   },
  { delay: 20825, percent: 51.25932836   },
  { delay: 21675, percent: 45.96848934   },
  { delay: 22073, percent: 92.8807947    },
  { delay: 25835, percent: 28.90258216   },
  { delay: 26805, percent: 24.21471173   },
  { delay: 27025, percent: 32.22222222   },
  { delay: 27425, percent: 73.47232207   },
];

function startMultiBackline(member) {
  if (!member.gameState) {
    console.log(`[MultiBackline] ${member.label} skipped — no gameState`);
    return;
  }
  if (member.multiBacklineInterval) {
    console.log(`[MultiBackline] ${member.label} already running`);
    return;
  }

  console.log(`[MultiBackline] ${member.label} starting attackCycle myId=${member.myId}`);

  const startTime = Date.now();
  let running = true;

  // Store a cancel handle on the member
  member.multiBacklineInterval = { cancel: () => { running = false; } };

  async function loop() {
    while (running) {
      if (member.gameWs.readyState !== WebSocket.OPEN) {
        running = false;
        member.multiBacklineInterval = null;
        return;
      }
      await attackCycle({
        myId: member.myId,
        borders: member.gameState.borders,
        troopData: member.gameState.troopData,
        landData: member.gameState.landData,
        offsets: member.gameState.offsets,
        attackPercent: member.gameState.attackPercent ?? TARGET_ATTACK_UNIT_RATIO,
        gameWs: member.gameWs,
      });
      if (!running) break;
      // Wait MULTI_BACKLINE_INTERVAL_MS between full cycle completions
      await new Promise(r => setTimeout(r, MULTI_BACKLINE_INTERVAL_MS));
    }
    member.multiBacklineInterval = null;
  }

  loop();
}

function runOpeningSequence(member) {
  if (!member.multiBackline) return;

  logVerbose(`[Opening] ${member.label} scheduling ${GBv4_OPENING.length} opening steps`);

  for (const step of GBv4_OPENING) {
    const unitRatio = Math.round(step.percent / 100 * 1023);
    setTimeout(() => {
      if (member.gameWs.readyState !== WebSocket.OPEN) return;
      const packet = buildAttackPacket(unitRatio, NEUTRAL_LAND_TARGET_PLAYER);
      member.gameWs.send(packet);
      logVerbose(`[Opening] ${member.label} step delay=${step.delay}ms percent=${step.percent.toFixed(2)}% ratio=${unitRatio}`);
    }, step.delay);
  }
}

function connectToGameServer(joinInfo, session, ws) {
  logVerbose(`Connecting to game server: ${joinInfo.serverUrl}`);
  const gameWs = session.wsOptions
    ? new WebSocket(joinInfo.serverUrl, session.wsOptions)
    : new WebSocket(joinInfo.serverUrl);
  const targetSpawn = {
    clanTag: joinInfo.targetClanTag ?? session.targetClanTag,
    clanMarker: joinInfo.targetClanMarker,
    playerName: joinInfo.targetPlayer?.name ?? null,
    accountId: joinInfo.targetPlayer?.accountId ?? null,
    originalId: Number.isInteger(joinInfo.targetPlayer?.originalId) ? joinInfo.targetPlayer.originalId : null,
    assignmentIndex: Number.isInteger(joinInfo.targetAssignmentIndex) ? joinInfo.targetAssignmentIndex : null,
    assignmentCount: Number.isInteger(joinInfo.targetAssignmentCount) ? joinInfo.targetAssignmentCount : null,
    playerId: Number.isInteger(joinInfo.targetGameId) ? joinInfo.targetGameId : null,
  };
  let gameMember = null;

  const handshake = {
    challengeSolved: false,
  };

  gameWs.on('open', () => {
    sendPacket(
      'INIT',
      buildInitPacket(
        { buildNumber: session.buildNumber ?? 1130, isNotTerritorialDomain: true },
        { id: session.platformId ?? 0, version: session.platformVersion ?? 0 },
        session
      ),
      gameWs
    );
  });

  gameWs.on('message', (data) => {
    if (handshake.challengeSolved) {
      notePostJoinGamePacket(gameMember);
      const reader = isGameReader(gameMember);
      const shouldPrimeCache = shouldDecodeEarlyTargetCache(gameMember);
      if (!reader && !shouldPrimeCache) return;

      if (gameMember) {
        gameMember.firstPostJoinPacketDecoded = true;
      }
      const commands = gameMember.group.gameCommandTracker.update(data);
      mirrorTargetSpawns(commands, gameMember, {
        sendReadyMembers: reader,
        sendReaderMemberOnly: !reader,
      });
      return;
    }

    const reader = new BitStreamReader();
    reader.init(new Uint8Array(data));
    reader.readBits(1);
    const opcode = reader.readBits(6);

    debugGame(session, `[Game:${session.label}] Handshake opcode=${opcode} bytes=${data.length}`);

    if ((opcode === 9 || opcode === 20) && !handshake.challengeSolved) {
      const innerReader = new BitStreamReader();
      innerReader.init(new Uint8Array(data));
      innerReader.readBits(1);
      innerReader.readBits(6);

      const challenge = solveChallenge(innerReader);

      logVerbose('[Game] Challenge solved:', challenge);
      sendPacket('CHALLENGE', buildChallengeResponsePacket(challenge.challengeResponse, challenge.eventType), gameWs);

      if (opcode === 20) {
        return;
      }

      gameWs.send(session.rawPacket);
      sendPacket('GAME_JOIN', buildGamePacket(
        joinInfo.aEc,
        joinInfo.myId,
        session.timeBasedSeed,
        session.buildNumber ?? 1130
      ), gameWs);

      handshake.challengeSolved = true;
      gameMember = registerGameConnection(joinInfo, session, gameWs, targetSpawn);
      ws.close();
      logVerbose('[Game] Connected - closing lobby connection');

      if (LOG_GAME_PACKETS) {
        if (targetSpawn.playerId === null) {
          console.log(`[Target] Watching disabled: no ${targetSpawn.clanMarker ?? targetSpawn.clanTag ?? 'target clan'} player was assigned for this game`);
        } else {
          console.log(`[Target] Watching ${formatTargetLabel(targetSpawn)} as gamePlayerId=${targetSpawn.playerId}`);
        }
      }

      let sendCount = 0;
      setTimeout(function pingLoop() {
        if (gameWs.readyState !== WebSocket.OPEN) return;

        if (sendCount === 1) {
          gameWs.send(new Uint8Array([0x09, 0x40]));
          debugGame(session, `[Game:${session.label}] Sent second-time gameping (0940)`);
        } else {
          gameWs.send(new Uint8Array([0x08, 0x40]));
          debugGame(session, `[Game:${session.label}] Sent gameping (0840)`);
        }

        sendCount++;
        setTimeout(pingLoop, 15000);
      }, 15000);

      return;
    }

    if (opcode === 21 && !handshake.challengeSolved) {
      const innerReader = new BitStreamReader();
      innerReader.init(new Uint8Array(data));
      innerReader.readBits(1);
      innerReader.readBits(6);

      const challenge = solveExecutableChallenge(innerReader);
      debugGame(session, `[Game:${session.label}] Executable challenge details`, {
        difficultyBits: challenge.difficultyBits,
        challengeResponse: challenge.challengeResponse,
        executableResult: challenge.executableResult,
      });
      sendPacket(
        'EXEC_CHALLENGE',
        buildExecutableChallengeResponse(challenge.challengeResponse, challenge.executableResult),
        gameWs
      );
      return;
    }

    logVerbose(`[Game] Unhandled handshake opcode=${opcode} bytes=${data.length}`);

  });

  gameWs.on('close', () => {
    unregisterGameConnection(gameMember);
    logVerbose('[Game] Connection closed');
  });
  gameWs.on('error', (err) => console.error('[Game] Error:', err));
}

function formatTargetLabel(targetSpawn) {
  const clan = targetSpawn.clanMarker ?? (targetSpawn.clanTag ? `[${targetSpawn.clanTag}]` : 'all players');
  const name = targetSpawn.playerName ? `"${targetSpawn.playerName}"` : `player ${targetSpawn.playerId}`;
  const assignment = targetSpawn.assignmentIndex !== null && targetSpawn.assignmentCount !== null
    ? ` ${targetSpawn.assignmentIndex + 1}/${targetSpawn.assignmentCount}`
    : '';

  return `${clan}${assignment} ${name}`;
}

function notePostJoinGamePacket(member) {
  if (!member) return;
  if (member.firstPostJoinPacketSeen) return;

  member.firstPostJoinPacketSeen = true;

  // In multiBackline mode: skip target spawn entirely.
  // Opening sequence and attackCycle are started manually via Q command.
  if (member.multiBackline) {
    logVerbose(`[MultiBackline] ${member.label} game started; waiting for Q command to start`);
    return;
  }

  if (!Number.isInteger(member.targetSpawn.playerId)) return;

  member.targetCacheDecodeUntil = Date.now() + TARGET_CACHE_DECODE_WINDOW_MS;
  member.targetSpawnDelayTimer = setTimeout(() => {
    member.targetSpawnDelayTimer = null;
    member.targetSpawnDelayElapsed = true;

    const tileIndex = member.group.targetTilesByPlayerId.get(member.targetSpawn.playerId);
    if (sendDelayedTargetSpawnToMember(member, tileIndex)) {
      logVerbose(`[Target] ${member.label} spawned at saved target tile=${tileIndex} after 19s delay`);
    } else if (!Number.isInteger(tileIndex)) {
      logVerbose(`[Target] ${member.label} delay elapsed, but no target tile has been seen yet`);
    }
  }, TARGET_SPAWN_DELAY_MS);

  if (LOG_GAME_PACKETS) {
    console.log(`[Target] ${member.label} first game packet after join received; waiting ${TARGET_SPAWN_DELAY_MS / 1000}s before target spawn`);
  }
}

function shouldDecodeEarlyTargetCache(member) {
  if (!member) return false;
  if (member.targetSpawnSent) return false;
  if (!Number.isInteger(member.targetSpawn.playerId)) return false;
  if (member.group.targetTilesByPlayerId.has(member.targetSpawn.playerId)) return false;
  if (member.group.reader && member.group.reader !== member) return false;

  return Date.now() <= member.targetCacheDecodeUntil;
}

function sendTargetSpawnToMember(member, tileIndex) {
  if (!Number.isInteger(tileIndex)) return false;
  if (member.gameWs.readyState !== WebSocket.OPEN) return false;

  member.gameWs.send(buildSpawnPacket(tileIndex));
  return true;
}

function sendDelayedTargetSpawnToMember(member, tileIndex) {
  if (member.targetSpawnSent) return false;
  if (!sendTargetSpawnToMember(member, tileIndex)) return false;

  member.targetSpawnSent = true;
  startAttackSequence(member);
  return true;
}

function sendPreparedAttackToMember(member, packet) {
  if (member.gameWs.readyState !== WebSocket.OPEN) return false;

  member.gameWs.send(packet);
  return true;
}

function startAttackSequence(member) {
  const targetPlayer = member.targetSpawn.playerId;
  if (!Number.isInteger(targetPlayer)) return;
  if (member.attackSequenceStarted) return;

  member.attackSequenceStarted = true;
  member.neutralAttackPacket = buildAttackPacket(NEUTRAL_ATTACK_UNIT_RATIO, NEUTRAL_LAND_TARGET_PLAYER);

  member.neutralAttackTimer = setTimeout(() => {
    member.neutralAttackTimer = null;

    if (!sendPreparedAttackToMember(member, member.neutralAttackPacket)) {
      return;
    }

    logVerbose(`[Attack] ${member.label} sent 30% neutral attack target=${NEUTRAL_LAND_TARGET_PLAYER}; starting attackCycle every ${TARGET_ATTACK_INTERVAL_MS}ms`);

    // Use attackCycle if shared game state is available, otherwise fall back to static target packet
    if (member.gameState) {
      const runCycle = () => {
        if (member.gameWs.readyState !== WebSocket.OPEN) {
          clearInterval(member.targetAttackInterval);
          member.targetAttackInterval = null;
          return;
        }
        attackCycle({
          myId: targetPlayer,
          borders: member.gameState.borders,
          troopData: member.gameState.troopData,
          landData: member.gameState.landData,
          offsets: member.gameState.offsets,
          attackPercent: member.gameState.attackPercent ?? TARGET_ATTACK_UNIT_RATIO,
          gameWs: member.gameWs,
        });
      };
      member.targetAttackInterval = setInterval(runCycle, TARGET_ATTACK_INTERVAL_MS);
    } else {
      member.targetAttackPacket = buildAttackPacket(TARGET_ATTACK_UNIT_RATIO, targetPlayer);
      member.targetAttackInterval = setInterval(() => {
        if (!sendPreparedAttackToMember(member, member.targetAttackPacket)) {
          clearInterval(member.targetAttackInterval);
          member.targetAttackInterval = null;
        }
      }, TARGET_ATTACK_INTERVAL_MS);
    }
  }, POST_SPAWN_NEUTRAL_ATTACK_DELAY_MS);
}

function mirrorTargetSpawns(commands, readerMember, options = {}) {
  const sendReadyMembers = options.sendReadyMembers !== false;
  const sendReaderMemberOnly = options.sendReaderMemberOnly === true;
  const spawnCommands = commands.filter((command) => (
    command.commandId === 0 &&
    !command.truncated
  ));

  for (const spawnCommand of spawnCommands) {
    const { group } = readerMember;
    const playerId = spawnCommand.playerId;
    const tileIndex = spawnCommand.fields.tileIndex;
    group.targetTilesByPlayerId.set(playerId, tileIndex);

    let sentCount = 0;
    let waitingCount = 0;
    let targetSpawn = null;

    for (const member of group.members) {
      if (sendReaderMemberOnly && member !== readerMember) continue;
      if (member.targetSpawn.playerId !== playerId) continue;
      targetSpawn = member.targetSpawn;

      if (!member.targetSpawnDelayElapsed) {
        waitingCount++;
        continue;
      }

      if (sendDelayedTargetSpawnToMember(member, tileIndex)) {
        sentCount++;
      }
    }

    if (targetSpawn) {
      logVerbose(`[Target] ${formatTargetLabel(targetSpawn)} spawned at tile=${tileIndex}; saved latest tile, sent to ${sentCount} ready connection(s), ${waitingCount} still waiting`);
    }
  }
}

function startMultiBacklineForAll() {
  for (const group of gameGroups.values()) {
    for (const member of group.members) {
      startMultiBackline(member);
    }
  }
}

function stopMultiBacklineForAll() {
  for (const group of gameGroups.values()) {
    for (const member of group.members) {
      if (member.multiBacklineInterval) {
        member.multiBacklineInterval.cancel();
        member.multiBacklineInterval = null;
        logVerbose(`[MultiBackline] ${member.label} attackCycle stopped`);
      }
    }
  }
}

function spawnAllMultiBackline(spawnTiles) {
  const MAX_WAIT_MS = 30000;
  const RETRY_INTERVAL_MS = 500;
  let elapsed = 0;
  const spawnedMembers = new Set();

  const shardIndex = Number.parseInt(process.env.ECHO_SHARD_INDEX ?? '0', 10) || 0;
  const shardCount = Number.parseInt(process.env.ECHO_SHARD_COUNT ?? '1', 10) || 1;

  function getEligibleMembers() {
    const members = [];
    for (const group of gameGroups.values()) {
      for (const member of group.members) {
        if (member.multiBackline) members.push(member);
      }
    }
    return members;
  }

  function attempt() {
    const members = getEligibleMembers();

    for (let localIdx = 0; localIdx < members.length; localIdx++) {
      const member = members[localIdx];
      if (spawnedMembers.has(member)) continue;

      const globalTileIdx = shardIndex + localIdx * shardCount;
      if (globalTileIdx >= spawnTiles.length) continue;

      const tile = spawnTiles[globalTileIdx];
      if (!Number.isInteger(tile)) continue;

      if (member.gameWs.readyState !== WebSocket.OPEN) continue;

      member.gameWs.send(buildSpawnPacket(tile));
      spawnedMembers.add(member);
      console.log(`[Spawn] ${member.label} spawned at tile=${tile} (globalSlot=${globalTileIdx})`);
    }

    elapsed += RETRY_INTERVAL_MS;
    if (elapsed < MAX_WAIT_MS) {
      setTimeout(attempt, RETRY_INTERVAL_MS);
    }
  }

  attempt();
}

function runOpeningForAll() {
  for (const group of gameGroups.values()) {
    for (const member of group.members) {
      if (member.multiBackline) runOpeningSequence(member);
    }
  }
}

function donateAll(percent, targetPlayerId) {
  const unitRatio = Math.round(Math.min(100, Math.max(0, percent)) / 100 * 1023);
  const packet = buildDonationPacket(unitRatio, targetPlayerId);
  for (const group of gameGroups.values()) {
    for (const member of group.members) {
      if (!member.multiBackline) continue;
      if (member.gameWs.readyState !== WebSocket.OPEN) continue;
      member.gameWs.send(packet);
    }
  }
  console.log(`[Donate] ${percent}% -> playerId=${targetPlayerId} ratio=${unitRatio}`);
}

function attackAll(percent, targetPlayerId) {
  const unitRatio = Math.round(Math.min(100, Math.max(0, percent)) / 100 * 1023);
  const packet = buildAttackPacket(unitRatio, targetPlayerId);
  for (const group of gameGroups.values()) {
    for (const member of group.members) {
      if (!member.multiBackline) continue;
      if (member.gameWs.readyState !== WebSocket.OPEN) continue;
      member.gameWs.send(packet);
    }
  }
  console.log(`[Attack] ${percent}% -> playerId=${targetPlayerId} ratio=${unitRatio}`);
}

function donateBot(botMyId, percent, targetPlayerId) {
  const unitRatio = Math.round(Math.min(100, Math.max(0, percent)) / 100 * 1023);
  const packet = buildDonationPacket(unitRatio, targetPlayerId);
  for (const group of gameGroups.values()) {
    for (const member of group.members) {
      if (member.myId !== botMyId) continue;
      if (member.gameWs.readyState !== WebSocket.OPEN) continue;
      member.gameWs.send(packet);
      console.log(`[Bot:${botMyId}] Donated ${percent}% -> playerId=${targetPlayerId}`);
      return;
    }
  }
  console.warn(`[Bot:${botMyId}] Not found for donate`);
}

function attackBot(botMyId, percent, targetPlayerId) {
  const unitRatio = Math.round(Math.min(100, Math.max(0, percent)) / 100 * 1023);
  const packet = buildAttackPacket(unitRatio, targetPlayerId);
  for (const group of gameGroups.values()) {
    for (const member of group.members) {
      if (member.myId !== botMyId) continue;
      if (member.gameWs.readyState !== WebSocket.OPEN) continue;
      member.gameWs.send(packet);
      console.log(`[Bot:${botMyId}] Attacked ${percent}% -> playerId=${targetPlayerId}`);
      return;
    }
  }
  console.warn(`[Bot:${botMyId}] Not found for attack`);
}

function startTickDono(targetPlayerId) {
  for (const group of gameGroups.values()) {
    for (const member of group.members) {
      if (!member.multiBackline) continue;
      if (member.tickDonoTimer) continue; // already running

      member.tickDonoTimer = setInterval(() => {
        if (member.gameWs.readyState !== WebSocket.OPEN) return;
        if (!member.gameState) return;

        const troops = member.gameState.troopData[member.myId];
        const land   = member.gameState.landData[member.myId];
        if (!land || land === 0) return;

        const ratio = troops / land;
        if (ratio > 100) {
          const packet = buildDonationPacket(Math.round(20 / 100 * 1023), targetPlayerId);
          member.gameWs.send(packet);
          console.log(`[TickDono] ${member.label} myId=${member.myId} ratio=${ratio.toFixed(1)} > 100 — donated 20% to player ${targetPlayerId}`);
        }
      }, 10000);

      console.log(`[TickDono] ${member.label} started watching myId=${member.myId}`);
    }
  }
}

function stopTickDono() {
  for (const group of gameGroups.values()) {
    for (const member of group.members) {
      if (member.tickDonoTimer) {
        clearInterval(member.tickDonoTimer);
        member.tickDonoTimer = null;
        console.log(`[TickDono] ${member.label} stopped`);
      }
    }
  }
}

module.exports = { connectToGameServer, startMultiBacklineForAll, stopMultiBacklineForAll, spawnAllMultiBackline, runOpeningForAll, donateAll, attackAll, donateBot, attackBot, startTickDono, stopTickDono };
