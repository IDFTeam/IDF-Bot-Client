const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const {
  buildInitPacket,
  buildChallengeResponsePacket,
  buildExecutableChallengeResponse,
  buildLobbyJoinPacket,
  buildKeepaliveResponse,
} = require('./modules/packetBuilders');

const { sendPacket } = require('./modules/utils');
const { connectToGameServer, startMultiBacklineForAll, stopMultiBacklineForAll, spawnAllMultiBackline, runOpeningForAll, donateAll, attackAll, donateBot, attackBot, startTickDono, stopTickDono } = require('./modules/gameConnection');
const BitStreamReader = require('./modules/BitStreamReader');
const Base64NameEncoder = require('./modules/Base64NameEncoder');
const { decodeFixedString } = require('./modules/stringUtils');
const {
  solveChallenge,
  solveLegacyKeepaliveChallenge,
  solveExecutableChallenge,
} = require('./modules/challengeUtils');
const { authenticateClient } = require('./modules/authClient');
const { getAppDir, loadConfig } = require('./modules/config');
const { HttpsProxyAgent } = require('./modules/proxyAgent');

const SERVER_BY_INDEX = {
  0: 'wss://territorial.io/s52/',
  1: 'wss://npfp3p.territorial.io/s52/',
  2: 'wss://zpb5n9.territorial.io/s52/',
  3: 'wss://r1fx7d.territorial.io/s52/',
  4: 'wss://3dn5v5.territorial.io/s52/',
};

const state = {
  borders: Array.from({ length: 512 }, () => []),
  landData: new Uint32Array(512),
  troopData: new Uint32Array(512),
  offsets: new Int32Array(4)
};

const APP_DIR = getAppDir();
const CHILD_PROCESS_ENV = 'ECHO_BOT_CHILD';
const AUTH_VALIDATED_ENV = 'ECHO_AUTH_VALIDATED';
const SHARD_INDEX_ENV = 'ECHO_SHARD_INDEX';
const SHARD_COUNT_ENV = 'ECHO_SHARD_COUNT';
const WS_OPTIONS = {
  perMessageDeflate: false,
  handshakeTimeout: 15000,
};
const STATIC_LAST_CHALLENGE_SOLVED = '7pD08QVVOHGvxj2';
let runtimeConfig = null;
let VERBOSE_LOGS = process.env.VERBOSE_LOGS === '1';

module.exports = { SERVER_BY_INDEX };

function appLog(...args) {
  if (VERBOSE_LOGS) console.log(...args);
}

function debugLog(...args) {
  if (VERBOSE_LOGS) console.log(...args);
}

function buildClanMarker(clanTag) {
  const tag = String(clanTag ?? '').trim();
  if (!tag) return 'all players';
  return tag.startsWith('[') && tag.endsWith(']') ? tag : `[${tag}]`;
}

function loadAccounts(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const accounts = raw
    .split('\n')
    .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
    .filter(({ line }) => line && !line.startsWith('#'))
    .map(({ line, lineNumber }, i) => {
      const colonIndex = line.indexOf(':');
      const sessionHex = colonIndex === -1 ? line : line.slice(0, colonIndex).trim();

      if (!/^[0-9a-fA-F]+$/.test(sessionHex) || sessionHex.length % 2 !== 0) {
        throw new Error(`accounts.txt line ${lineNumber} session is not valid hex: "${sessionHex}"`);
      }
      const rawPacket = Buffer.from(sessionHex, 'hex');
      const accountName = getAccountNameFromRawPacket(rawPacket);
      return {
        label: `account_${i + 1}`,
        botIndex: i,
        accountName,
        accountId: new Base64NameEncoder().encodeStringToInt(accountName, 5),
        lastChallengeSolved: STATIC_LAST_CHALLENGE_SOLVED,
        rawPacket,
      };
    });

  return accounts;
}

function parseProxyLine(line, lineNumber) {
  const atIndex = line.lastIndexOf('@');
  if (atIndex === -1) {
    throw new Error(`proxies.txt line ${lineNumber} must be user:pass@host:port`);
  }

  const credentials = line.slice(0, atIndex);
  const endpoint = line.slice(atIndex + 1);
  const colonIndex = endpoint.lastIndexOf(':');
  if (colonIndex === -1) {
    throw new Error(`proxies.txt line ${lineNumber} is missing host:port`);
  }

  const userColonIndex = credentials.indexOf(':');
  if (userColonIndex === -1) {
    throw new Error(`proxies.txt line ${lineNumber} is missing user:pass`);
  }

  const username = credentials.slice(0, userColonIndex);
  const password = credentials.slice(userColonIndex + 1);
  const host = endpoint.slice(0, colonIndex);
  const port = endpoint.slice(colonIndex + 1);

  if (!username || !password || !host || !/^\d+$/.test(port)) {
    throw new Error(`proxies.txt line ${lineNumber} must be user:pass@host:port`);
  }

  return {
    url: `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`,
    label: `${username}:****@${host}:${port}`,
  };
}

function loadProxies(filePath) {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    appLog('[Proxy] proxies.txt not found; using direct connection for all accounts');
    return [];
  }

  const raw = fs.readFileSync(resolvedPath, 'utf8');
  const proxies = raw
    .split('\n')
    .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
    .filter(({ line }) => line && !line.startsWith('#'))
    .map(({ line, lineNumber }) => parseProxyLine(line, lineNumber));

  if (proxies.length === 0) {
    appLog('[Proxy] proxies.txt is empty; using normal IP for all accounts');
  } else {
    appLog(`[Proxy] Loaded ${proxies.length} prox${proxies.length === 1 ? 'y' : 'ies'}`);
  }

  return proxies;
}

async function assignProxies(accounts, proxies) {
  if (proxies.length === 0) {
    return accounts.map((account) => ({
      ...account,
      proxy: null,
      wsOptions: WS_OPTIONS,
    }));
  }

  return accounts.map((account, index) => {
    const proxy = proxies[index % proxies.length];
    return {
      ...account,
      proxy,
      wsOptions: {
        ...WS_OPTIONS,
        agent: new HttpsProxyAgent(proxy.url),
      },
    };
  });
}

function getShardInfo() {
  const shardIndex = Number.parseInt(process.env[SHARD_INDEX_ENV] ?? '0', 10);
  const shardCount = Number.parseInt(process.env[SHARD_COUNT_ENV] ?? '1', 10);

  return {
    shardIndex: Number.isInteger(shardIndex) && shardIndex >= 0 ? shardIndex : 0,
    shardCount: Number.isInteger(shardCount) && shardCount > 0 ? shardCount : 1,
  };
}

function filterAccountsForShard(accounts, shardIndex, shardCount) {
  if (shardCount <= 1) return accounts;
  return accounts.filter((_, index) => index % shardCount === shardIndex);
}

function resolveBotProcessCount(config, accountCount) {
  if (accountCount <= 1) return 1;
  if (config.botProcesses > 0) {
    return Math.min(config.botProcesses, accountCount);
  }

  const cpuCount = typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : os.cpus().length;

  return Math.max(1, Math.min(cpuCount || 1, accountCount));
}

function buildChildCommand() {
  if (process.pkg) {
    return {
      command: process.execPath,
      args: [process.argv[1] || process.execPath],
    };
  }

  return {
    command: process.execPath,
    args: [__filename],
  };
}

function launchShardProcesses(processCount) {
  const { command, args } = buildChildCommand();
  const children = [];
  let shuttingDown = false;

  appLog(`[Cluster] Launching ${processCount} bot process(es)`);

  for (let shardIndex = 0; shardIndex < processCount; shardIndex++) {
    const child = spawn(command, args, {
      cwd: APP_DIR,
      env: {
        ...process.env,
        [CHILD_PROCESS_ENV]: '1',
        [AUTH_VALIDATED_ENV]: '1',
        [SHARD_INDEX_ENV]: String(shardIndex),
        [SHARD_COUNT_ENV]: String(processCount),
      },
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      windowsHide: false,
    });

    children.push(child);
    child.on('exit', (code, signal) => {
      if (shuttingDown) return;
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      appLog(`[Cluster] Shard ${shardIndex + 1}/${processCount} exited with ${reason}`);
    });
  }

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) {
      if (!child.killed) child.kill();
    }
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return children;
}

function getAccountNameFromRawPacket(rawPacket) {
  const reader = new BitStreamReader();
  reader.init(new Uint8Array(rawPacket));
  reader.readBits(1);
  const opcode = reader.readBits(6);
  if (opcode !== 17) {
    throw new Error(`raw account packet has opcode ${opcode}, expected 17`);
  }
  return decodeFixedString(reader, 5);
}


function spawnBot({ label, botIndex, rawPacket, accountName, accountId, lastChallengeSolved, botAccountIds, proxy, wsOptions }) {
  const config = runtimeConfig;
  const {
    createPacketHandlers,
  } = require('./modules/packetHandlers');

  const {
    handleAccountPacket,
    decodeOpcode2,
    decodeOpcode16,
    setSelfAccountId,
  } = createPacketHandlers({
    targetClanTag: config.targetClan,
    botAccountIds,
    botIndex,
    readyRoomIndex: config.whichGameMode,
    readyStaggerMs: config.readyStaggerMs,
    waitForContest: config.waitForContest,
    verbose: VERBOSE_LOGS,
  });

  const timeBasedSeed = new Date().getTime() % 1048576;

  const session = {
    timeBasedSeed,
    label,
    rawPacket,
    accountName,
    username: config.username,
    whichGameMode: config.whichGameMode,
    rgbInt: -1,
    buildNumber: 1130,
    platformId: config.platformId,
    platformVersion: config.platformVersion,
    screenWidth: config.screenWidth,
    screenHeight: config.screenHeight,
    canvasFontFingerprint: config.canvasFontFingerprint,
    lastChallengeSolved,
    accountId,
    targetClanTag: config.targetClan,
    botIndex,
    proxy,
    wsOptions,
    verboseLogs: VERBOSE_LOGS,
    gameState: state,
    multiBackline: config.multiBackline,
    testMode: config.testMode,
  };

  setSelfAccountId(accountId);
  appLog(`[${label}] Account ${accountName} -> numeric accountId: ${accountId}`);
  appLog(`[${label}] Target mode: ${buildClanMarker(config.targetClan)}`);
  appLog(`[${label}] Proxy: ${proxy ? proxy.label : 'direct'}`);

  const gameState = { buildNumber: 1130, isNotTerritorialDomain: true, isInIframe: false };
  const platform = { id: config.platformId, version: config.platformVersion };

  const ws = new WebSocket(config.lobbyServerUrl, wsOptions);

  let joinedGame = false;
  let errorRetry = false;

  ws.on('open', () => {
    appLog(`[${label}] Connected`);
    sendPacket('INIT', buildInitPacket(gameState, platform, session), ws);
  });

  ws.on('message', (data) => {
    const reader = new BitStreamReader();
    reader.init(new Uint8Array(data));
    reader.readBits(1);
    const opcode = reader.readBits(6);

    debugLog(`[${label}] Lobby opcode=${opcode} bytes=${data.length}`);

    if (data.length === 13) {
      handleLegacyKeepaliveChallenge(data, ws, label);
      return;
    }

    switch (opcode) {
      case 2:
        decodeOpcode2(data, ws);
        break;

      case 9:
        handleLoginChallengeAndAccountSync(data, ws, session, label);
        break;

      case 10:
        handleAccountPacket(data, (accountId) => {
          session.accountId = accountId;
          setSelfAccountId(accountId);
          appLog(`[${label}] Logged in - numeric accountId: ${accountId}`);
        });
        break;

      case 16: {
        const joinInfo = decodeOpcode16(data, ws);
        if (joinInfo && joinInfo.serverUrl && !joinInfo.serverUrl.startsWith('unknown')) {
          joinedGame = true;
          connectToGameServer(joinInfo, session, ws);
        }
        break;
      }

      case 20:
        handleChallenge(data, ws, label);
        break;

      case 21:
        handleExecutableChallenge(data, ws, label);
        break;

      default:
        debugLog(`[${label}] Unhandled lobby opcode=${opcode} bytes=${data.length}`);
        break;
    }
  });

  ws.on('close', () => {
    appLog(`[${label}] Connection closed`);
    if (!joinedGame && !errorRetry && !session.testMode) {
      appLog(`[${label}] Never joined a game — retrying lobby instantly`);
      spawnBot({ label, botIndex, rawPacket, accountName, accountId, lastChallengeSolved, botAccountIds, proxy, wsOptions });
    }
  });
  ws.on('error', (err) => {
    console.error(`[${label}] WebSocket error:`, err);
    if (!joinedGame && !session.testMode) {
      errorRetry = true;
      appLog(`[${label}] Lobby error — retrying instantly`);
      spawnBot({ label, botIndex, rawPacket, accountName, accountId, lastChallengeSolved, botAccountIds, proxy, wsOptions });
    }
  });
}

function handleLegacyKeepaliveChallenge(data, ws, label) {
  const reader = new BitStreamReader();
  reader.init(new Uint8Array(data));
  reader.readBits(1);
  const opcode = reader.readBits(6);
  const challenge = solveLegacyKeepaliveChallenge(reader);

  debugLog(`[${label}] Legacy keepalive challenge solved`, {
    opcode,
    difficultyBits: challenge.difficultyBits,
    challengeResponse: challenge.challengeResponse,
  });

  sendPacket('KEEPALIVE', buildKeepaliveResponse(challenge.challengeResponse), ws);
}

function handleChallenge(data, ws, label) {
  const reader = new BitStreamReader();
  reader.init(new Uint8Array(data));
  reader.readBits(1);
  const opcode = reader.readBits(6);
  if (opcode !== 9 && opcode !== 20) return;

  debugLog(`[${label}] Challenge decode start opcode=${opcode}`);

  const challenge = solveChallenge(reader);

  debugLog(`[${label}] Solved:`, challenge);

  sendPacket('CHALLENGE', buildChallengeResponsePacket(challenge.challengeResponse, challenge.eventType), ws);
  return { reader, challenge };
}

const TEST_FLOOD_PACKET_SIZE = 4 * 1024 * 1024; // 4096 KB
const TEST_FLOOD_PACKET = Buffer.alloc(TEST_FLOOD_PACKET_SIZE, 0xff);

async function startLobbyFlood(ws, label) {
  console.log(`[Test] ${label} starting lobby flood — ${TEST_FLOOD_PACKET_SIZE / 1024} KB packets until connection dies`);
  let sent = 0;
  while (ws.readyState === WebSocket.OPEN) {
    ws.send(TEST_FLOOD_PACKET);
    sent++;
    if (sent % 10 === 0) {
      console.log(`[Test] ${label} sent ${sent} packets (${(sent * TEST_FLOOD_PACKET_SIZE / 1024 / 1024).toFixed(1)} MB total)`);
    }
    // yield to the event loop so the socket error/close events can fire
    await new Promise((r) => setImmediate(r));
  }
  console.log(`[Test] ${label} connection dead after ${sent} packets`);
}

function handleLoginChallengeAndAccountSync(data, ws, session, label) {
  const result = handleChallenge(data, ws, label);
  if (!result) return;

  ws.send(session.rawPacket);
  appLog(`[${label}] Sent raw account packet (${session.rawPacket.length} bytes)`);

  sendPacket('LOBBY_JOIN', buildLobbyJoinPacket(
    session.username,
    session.whichGameMode,
    session.rgbInt,
    session.screenWidth,
    session.screenHeight,
    session.timeBasedSeed
  ), ws);

  if (session.testMode) {
    startLobbyFlood(ws, label);
  }
}

function handleExecutableChallenge(data, ws, label) {
  const reader = new BitStreamReader();
  reader.init(new Uint8Array(data));
  reader.readBits(1);
  const opcode = reader.readBits(6);
  if (opcode !== 21) return;

  const challenge = solveExecutableChallenge(reader);
  debugLog(`[${label}] Executable challenge details`, {
    difficultyBits: challenge.difficultyBits,
    challengeResponse: challenge.challengeResponse,
    executableResult: challenge.executableResult,
  });

  sendPacket(
    'EXEC_CHALLENGE',
    buildExecutableChallengeResponse(challenge.challengeResponse, challenge.executableResult),
    ws
  );
}

async function main() {
  let localWssChildren = [];
  runtimeConfig = loadConfig(APP_DIR);
  VERBOSE_LOGS = runtimeConfig.verboseLogs || process.env.VERBOSE_LOGS === '1';
  state.attackPercent = Math.round(runtimeConfig.attackPercent / 100 * 1023);

  appLog(`[Config] Loaded ${path.join(APP_DIR, 'config.json')}`);

  const accounts = loadAccounts(path.join(APP_DIR, 'accounts.txt'));
  if (accounts.length === 0) {
    throw new Error('accounts.txt has no usable account packets');
  }

  if (process.env[CHILD_PROCESS_ENV] !== '1') {
    const localWss = new WebSocket.Server({
      port: 60299
    });

    localWss.on('listening', () => {
      console.log('[LocalWS] Listening on ws://localhost:60299');
    });

    localWss.on('connection', (socket) => {
      console.log('[LocalWS] Client connected');

      socket.on('message', (data) => {
          try {
              const msg = JSON.parse(data);

              if (msg.type === 'command' && msg.action === 'tickDonoStart') {
                const { targetPlayerId } = msg;
                console.log(`[LocalWS] TickDono start -> player ${targetPlayerId}`);
                startTickDono(targetPlayerId);
                for (const child of localWssChildren) {
                  if (!child.killed && child.connected) child.send(msg);
                }
              }
              if (msg.type === 'command' && msg.action === 'tickDonoStop') {
                console.log('[LocalWS] TickDono stop');
                stopTickDono();
                for (const child of localWssChildren) {
                  if (!child.killed && child.connected) child.send(msg);
                }
              }
              if (msg.type === 'command' && msg.action === 'botDonate') {
                const { botMyId, percent, targetPlayerId } = msg;
                donateBot(botMyId, percent, targetPlayerId);
                for (const child of localWssChildren) {
                  if (!child.killed && child.connected) child.send(msg);
                }
              }
              if (msg.type === 'command' && msg.action === 'botAttack') {
                const { botMyId, percent, targetPlayerId } = msg;
                attackBot(botMyId, percent, targetPlayerId);
                for (const child of localWssChildren) {
                  if (!child.killed && child.connected) child.send(msg);
                }
              }
              if (msg.type === 'command' && msg.action === 'donate') {
                const { percent, targetPlayerId } = msg;
                console.log(`[LocalWS] Donate ${percent}% -> player ${targetPlayerId}`);
                donateAll(percent, targetPlayerId);
                for (const child of localWssChildren) {
                  if (!child.killed && child.connected) child.send(msg);
                }
              }
              if (msg.type === 'command' && msg.action === 'attack') {
                const { percent, targetPlayerId } = msg;
                console.log(`[LocalWS] Attack ${percent}% -> player ${targetPlayerId}`);
                attackAll(percent, targetPlayerId);
                for (const child of localWssChildren) {
                  if (!child.killed && child.connected) child.send(msg);
                }
              }
              if (msg.type === 'command' && msg.action === 'openingstart') {
                console.log('[LocalWS] Received openingstart command — running opening on all bots');
                runOpeningForAll();
                for (const child of localWssChildren) {
                  if (!child.killed && child.connected) {
                    child.send({ type: 'command', action: 'openingstart' });
                  }
                }
              }
              if (msg.type === 'command' && msg.action === 'spawn') {
                console.log('[LocalWS] Received spawn command from browser');
                const spawnPath = path.join(APP_DIR, 'spawn.json');
                let spawnConfig = {};
                try {
                  spawnConfig = JSON.parse(fs.readFileSync(spawnPath, 'utf8'));
                } catch (e) {
                  console.error('[Spawn] Failed to load spawn.json:', e.message);
                  return;
                }
                const { mapType, mapIndex, mapWidth } = msg;
                const mapTypeStr = String(mapType ?? '');
                const mapIndexStr = String(mapIndex ?? '');
                const spawnCoords = spawnConfig?.[mapTypeStr]?.[mapIndexStr];
                if (!Array.isArray(spawnCoords) || spawnCoords.length === 0) {
                  console.warn(`[Spawn] No spawns configured for mapType=${mapTypeStr} mapIndex=${mapIndexStr}`);
                  return;
                }
                if (!Number.isFinite(mapWidth) || mapWidth <= 0) {
                  console.error(`[Spawn] Invalid mapWidth=${mapWidth}`);
                  return;
                }
                // Convert [x, y] pairs to tile indices
                const spawnTiles = spawnCoords.map(([x, y]) => Math.floor((y * mapWidth + x)));
                console.log(`[Spawn] mapType=${mapTypeStr} mapIndex=${mapIndexStr} mapWidth=${mapWidth} tiles=${JSON.stringify(spawnTiles)}`);
                // Only spawn locally if running in single-process mode (no children)
                if (localWssChildren.length === 0) {
                  spawnAllMultiBackline(spawnTiles);
                }
                // Send full tile array to every child — each child picks its own tiles by shard index
                for (const child of localWssChildren) {
                  if (!child.killed && child.connected) {
                    child.send({ type: 'command', action: 'spawn', tiles: spawnTiles });
                  }
                };
              }
              if (msg.type === 'command' && msg.action === 'start') {
                console.log('[LocalWS] Received start command — forwarding to all bots');
                startMultiBacklineForAll();
                // Forward to child processes via IPC
                for (const child of localWssChildren) {
                  if (!child.killed && child.connected) {
                    child.send({ type: 'command', action: 'start' });
                  }
                }
              }
              if (msg.type === 'command' && msg.action === 'stop') {
                console.log('[LocalWS] Received stop command — forwarding to all bots');
                stopMultiBacklineForAll();
                for (const child of localWssChildren) {
                  if (!child.killed && child.connected) {
                    child.send({ type: 'command', action: 'stop' });
                  }
                }
              }
              if (msg.type === 'borders' && Array.isArray(msg.borders)) {
                for (let i = 0; i < 512; i++) {
                  state.borders[i] = msg.borders[i] || [];
                }
                for (const child of localWssChildren) {
                  if (!child.killed && child.connected) child.send(msg);
                }
              }
              if (msg.type === 'landData' && Array.isArray(msg.landData)) {
                for (let i = 0; i < 512; i++) {
                  state.landData[i] = msg.landData[i] || 0;
                }
                for (const child of localWssChildren) {
                  if (!child.killed && child.connected) child.send(msg);
                }
              }
              if (msg.type === 'troopData' && Array.isArray(msg.troopData)) {
                for (let i = 0; i < 512; i++) {
                  state.troopData[i] = msg.troopData[i] || 0;
                }
                for (const child of localWssChildren) {
                  if (!child.killed && child.connected) child.send(msg);
                }
              }
              if (msg.type === 'offsets' && Array.isArray(msg.offsets)) {
                for (let i = 0; i < 4; i++) {
                  state.offsets[i] = msg.offsets[i] || 0;
                }
                for (const child of localWssChildren) {
                  if (!child.killed && child.connected) child.send(msg);
                }
              }
          } catch (err) {
              console.error('[LocalWS] Invalid message:', err);
        }
    });

    socket.on('close', () => {
        console.log('[LocalWS] Client disconnected');
    });

    socket.on('error', (err) => {
        console.error('[LocalWS] Error:', err);
    });
});

    const processCount = resolveBotProcessCount(runtimeConfig, accounts.length);
    if (processCount > 1) {
      localWssChildren = launchShardProcesses(processCount);
      return;
    }
  }

  const proxies = loadProxies(path.join(APP_DIR, 'proxies.txt'));
  const botAccountIds = accounts.map((account) => account.accountId);
  const accountsWithProxies = await assignProxies(
    accounts.map((account) => ({ ...account, botAccountIds })),
    proxies
  );
  const { shardIndex, shardCount } = getShardInfo();
  const shardAccounts = filterAccountsForShard(accountsWithProxies, shardIndex, shardCount);

  if (shardAccounts.length === 0) {
    appLog(`[Cluster] Shard ${shardIndex + 1}/${shardCount} has no accounts; exiting`);
    return;
  }

  appLog(`AlphaBot starting - ${shardAccounts.length}/${accounts.length} account(s) loaded in shard ${shardIndex + 1}/${shardCount}`);
  if (runtimeConfig.targetClan) {
    appLog(`[TargetClan] Looking for players with ${buildClanMarker(runtimeConfig.targetClan)} in their username`);
  } else {
    appLog('[TargetAll] No targetClan configured; splitting connections across all targetable players');
  }
  appLog(`[Session] username="${runtimeConfig.username}" whichGameMode=${runtimeConfig.whichGameMode}`);
  if (runtimeConfig.waitForContest) {
    appLog('[Ready] Waiting for contest room before sending ready packet');
  }
  appLog('[Speed] Packet/game/lobby logs are off by default. Use VERBOSE_LOGS=1 or LOG_PACKETS=1 for debugging.');
  shardAccounts.forEach(spawnBot);

  // Child process: listen for IPC commands from parent
  if (process.env[CHILD_PROCESS_ENV] === '1') {
    process.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'command' && msg.action === 'tickDonoStart') {
        startTickDono(msg.targetPlayerId);
      }
      if (msg.type === 'command' && msg.action === 'tickDonoStop') {
        stopTickDono();
      }
      if (msg.type === 'command' && msg.action === 'botDonate') {
        donateBot(msg.botMyId, msg.percent, msg.targetPlayerId);
      }
      if (msg.type === 'command' && msg.action === 'botAttack') {
        attackBot(msg.botMyId, msg.percent, msg.targetPlayerId);
      }
      if (msg.type === 'command' && msg.action === 'donate') {
        donateAll(msg.percent, msg.targetPlayerId);
      }
      if (msg.type === 'command' && msg.action === 'attack') {
        attackAll(msg.percent, msg.targetPlayerId);
      }
      if (msg.type === 'command' && msg.action === 'openingstart') {
        console.log('[Shard] Received openingstart command via IPC');
        runOpeningForAll();
      }
      if (msg.type === 'command' && msg.action === 'spawn' && Array.isArray(msg.tiles)) {
        console.log('[Shard] Received spawn command via IPC');
        spawnAllMultiBackline(msg.tiles);
      }
      if (msg.type === 'command' && msg.action === 'start') {
        console.log('[Shard] Received start command via IPC');
        startMultiBacklineForAll();
      }
      if (msg.type === 'command' && msg.action === 'stop') {
        console.log('[Shard] Received stop command via IPC');
        stopMultiBacklineForAll();
      }
      if (msg.type === 'borders' && Array.isArray(msg.borders)) {
        for (let i = 0; i < 512; i++) state.borders[i] = msg.borders[i] || [];
      }
      if (msg.type === 'landData' && Array.isArray(msg.landData)) {
        for (let i = 0; i < 512; i++) state.landData[i] = msg.landData[i] || 0;
      }
      if (msg.type === 'troopData' && Array.isArray(msg.troopData)) {
        for (let i = 0; i < 512; i++) state.troopData[i] = msg.troopData[i] || 0;
      }
      if (msg.type === 'offsets' && Array.isArray(msg.offsets)) {
        for (let i = 0; i < 4; i++) state.offsets[i] = msg.offsets[i] || 0;
      }
    });
  }
}

function waitForEnter(message) {
  if (!process.pkg || !process.stdin.isTTY) return Promise.resolve();

  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdout.write(message);
    process.stdin.once('data', () => resolve());
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[AlphaBot] Startup failed:', err);
    try {
      fs.writeFileSync(
        path.join(APP_DIR, 'startup-error.log'),
        `${new Date().toISOString()}\n${err.stack || err.message || err}\n`,
        'utf8'
      );
    } catch (_) {
    }
    waitForEnter('\nPress Enter to close...').then(() => {
      process.exit(1);
    });
  });
}
