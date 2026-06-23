const BitStreamReader = require('./BitStreamReader');

const HEADER_SKIP_BITS = 2;
const COMMAND_HEADER_BITS = 13;

const COMMAND_DEFINITIONS = {
  0: {
    name: 'spawn',
    method: 'sendSpawnSp',
    argBits: 22,
    read(reader) {
      return { tileIndex: reader.readBits(22) };
    },
  },
  1: {
    name: 'attackTarget',
    method: 'attackTargetSp',
    argBits: 20,
    read(reader) {
      return { targetId: reader.readBits(10), amount: reader.readBits(10) };
    },
  },
  2: {
    name: 'pS',
    method: 'pS',
    argBits: 19,
    read(reader) {
      return { valueA: reader.readBits(10), valueB: reader.readBits(9) };
    },
  },
  3: {
    name: 'hh',
    method: 'hh',
    argBits: 37,
    read(reader) {
      return { valueA: reader.readBits(10), valueB: reader.readBits(27) };
    },
  },
  4: {
    name: 'hk',
    method: 'hk',
    argBits: 26,
    read(reader) {
      return { valueA: reader.readBits(10), valueB: reader.readBits(16) };
    },
  },
  5: {
    name: 'cancelAttack',
    method: 'cancelAttackSp',
    argBits: 10,
    read(reader) {
      return { targetId: reader.readBits(10) };
    },
  },
  6: {
    name: 'pd',
    method: 'pd',
    argBits: 10,
    read(reader) {
      return { value: reader.readBits(10) };
    },
  },
  7: {
    name: 'voteChoice',
    method: 'sendVoteChoiceSp',
    argBits: 1,
    read(reader) {
      return { choice: reader.readBits(1) };
    },
  },
  8: {
    name: 'surrender',
    method: 'surrenderSp',
    argBits: 0,
    read() {
      return {};
    },
  },
  9: {
    name: 'qC',
    method: 'qC',
    argBits: 0,
    read() {
      return {};
    },
  },
  10: {
    name: 'hY',
    method: 'hY',
    argBits: 42,
    read(reader) {
      const packed = reader.readBits(20);
      const value = reader.readBits(22);
      return {
        packed,
        valueA: packed >> 10,
        valueB: value,
        valueC: packed % 1024,
      };
    },
  },
};

function toUint8Array(buffer) {
  if (buffer instanceof Uint8Array) return buffer;
  return new Uint8Array(buffer);
}

function commandArgs(commandId, fields) {
  switch (commandId) {
    case 0:
      return [fields.tileIndex];
    case 1:
      return [fields.targetId, fields.amount];
    case 2:
    case 3:
    case 4:
      return [fields.valueA, fields.valueB];
    case 5:
      return [fields.targetId];
    case 6:
      return [fields.value];
    case 7:
      return [fields.choice];
    case 10:
      return [fields.valueA, fields.valueB, fields.valueC];
    default:
      return [];
  }
}

function parseGameCommands(buffer) {
  const reader = new BitStreamReader();
  reader.init(toUint8Array(buffer));
  reader.bitPosition += HEADER_SKIP_BITS;

  const totalBits = 8 * reader.size;
  const commands = [];

  while (reader.bitPosition + COMMAND_HEADER_BITS <= totalBits) {
    const bitStart = reader.bitPosition;
    const commandId = reader.readBits(4);
    const playerId = reader.readBits(9);
    const definition = COMMAND_DEFINITIONS[commandId];

    if (!definition) {
      commands.push({
        commandId,
        playerId,
        name: 'unknown',
        method: 'unknown',
        fields: {},
        args: [],
        bitStart,
        bitEnd: reader.bitPosition,
      });
      continue;
    }

    if (reader.bitPosition + definition.argBits > totalBits) {
      commands.push({
        commandId,
        playerId,
        name: definition.name,
        method: definition.method,
        fields: {},
        args: [],
        bitStart,
        bitEnd: reader.bitPosition,
        truncated: true,
        remainingBits: totalBits - reader.bitPosition,
      });
      break;
    }

    const fields = definition.read(reader);
    commands.push({
      commandId,
      playerId,
      name: definition.name,
      method: definition.method,
      fields,
      args: commandArgs(commandId, fields),
      bitStart,
      bitEnd: reader.bitPosition,
    });
  }

  return {
    commands,
    leftoverBits: totalBits - reader.bitPosition,
  };
}

function formatCommand(command) {
  const values = Object.entries(command.fields)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
  const suffix = command.truncated
    ? ` truncated remainingBits=${command.remainingBits}`
    : values
      ? ` ${values}`
      : '';

  return `[GameCommand] ${command.method} player=${command.playerId}${suffix}`;
}

function createGameCommandTracker(options = {}) {
  const label = options.label || 'Game';
  const historyLimit = options.historyLimit ?? 200;
  const logCommands = options.logCommands ?? true;

  const state = {
    packetCount: 0,
    totalCommands: 0,
    commandsById: {},
    players: new Map(),
    history: [],
  };

  function getPlayer(playerId) {
    let player = state.players.get(playerId);
    if (!player) {
      player = {
        playerId,
        commandCount: 0,
        surrendered: false,
        spawned: false,
        lastCommand: null,
      };
      state.players.set(playerId, player);
    }
    return player;
  }

  function remember(command) {
    state.totalCommands++;
    state.commandsById[command.commandId] = (state.commandsById[command.commandId] || 0) + 1;

    const player = getPlayer(command.playerId);
    player.commandCount++;
    player.lastCommand = command;

    if (command.commandId === 0) {
      player.spawned = true;
      player.spawnTileIndex = command.fields.tileIndex;
    } else if (command.commandId === 1) {
      player.lastAttack = {
        targetId: command.fields.targetId,
        amount: command.fields.amount,
      };
    } else if (command.commandId === 5) {
      player.lastCanceledTargetId = command.fields.targetId;
    } else if (command.commandId === 7) {
      player.voteChoice = command.fields.choice;
    } else if (command.commandId === 8) {
      player.surrendered = true;
    }

    state.history.push(command);
    if (state.history.length > historyLimit) {
      state.history.shift();
    }
  }

  function update(buffer) {
    const packet = parseGameCommands(buffer);
    state.packetCount++;

    for (const command of packet.commands) {
      remember(command);
      if (logCommands) {
        console.log(`[${label}] ${formatCommand(command)}`);
      }
    }

    return packet.commands;
  }

  function getStateSnapshot() {
    return {
      packetCount: state.packetCount,
      totalCommands: state.totalCommands,
      commandsById: { ...state.commandsById },
      players: Array.from(state.players.values()).map((player) => ({ ...player })),
      history: state.history.slice(),
    };
  }

  return {
    update,
    getStateSnapshot,
  };
}

module.exports = {
  COMMAND_DEFINITIONS,
  createGameCommandTracker,
  formatCommand,
  parseGameCommands,
};
