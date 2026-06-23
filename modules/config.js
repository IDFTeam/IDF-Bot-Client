const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
  targetClan: 'OMEN',
  username: 'JoksiXtraUser',
  whichGameMode: 0,
  authServerUrl: 'https://echotestest.onrender.com/',
  loginUsername: '',
  loginPassword: '',
  lobbyServerUrl: 'wss://npfp3p.territorial.io/s52/',
  verboseLogs: false,
  botProcesses: 0,
  waitForContest: true,
  buildNumber: 1124,
  platformId: 0,
  platformVersion: 0,
  screenWidth: 1920,
  screenHeight: 1080,
  canvasFontFingerprint: 9794,
  readyStaggerMs: 100,
  multiBackline: false,
  attackPercent: 100,
  testMode: false,
};

function getAppDir() {
  return process.pkg ? path.dirname(process.execPath) : process.cwd();
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`Could not read ${filePath}: ${err.message}`);
  }
}

function writeDefaultConfig(filePath) {
  fs.writeFileSync(filePath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, 'utf8');
}

function toInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function loadConfig(appDir = getAppDir()) {
  const configPath = path.join(appDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    writeDefaultConfig(configPath);
    throw new Error(`config.json was missing, so a default one was created at ${configPath}. Edit it and start again.`);
  }

  const fileConfig = readJson(configPath);
  const config = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
  };

  config.targetClan = String(config.targetClan ?? DEFAULT_CONFIG.targetClan).trim();
  config.username = String(config.username ?? DEFAULT_CONFIG.username).slice(0, 20);
  config.whichGameMode = toInteger(config.whichGameMode, DEFAULT_CONFIG.whichGameMode);
  config.authServerUrl = String(config.authServerUrl ?? DEFAULT_CONFIG.authServerUrl).trim();
  config.loginUsername = String(config.loginUsername ?? '').trim();
  config.loginPassword = String(config.loginPassword ?? '');
  config.lobbyServerUrl = String(config.lobbyServerUrl ?? DEFAULT_CONFIG.lobbyServerUrl).trim();
  config.verboseLogs = config.verboseLogs === true || process.env.VERBOSE_LOGS === '1';
  config.botProcesses = toInteger(process.env.BOT_PROCESSES ?? config.botProcesses, DEFAULT_CONFIG.botProcesses);
  config.waitForContest = config.waitForContest === true || process.env.WAIT_FOR_CONTEST === '1';
  config.buildNumber = toInteger(config.buildNumber, DEFAULT_CONFIG.buildNumber);
  config.platformId = toInteger(config.platformId, DEFAULT_CONFIG.platformId);
  config.platformVersion = toInteger(config.platformVersion, DEFAULT_CONFIG.platformVersion);
  config.screenWidth = toInteger(config.screenWidth, DEFAULT_CONFIG.screenWidth);
  config.screenHeight = toInteger(config.screenHeight, DEFAULT_CONFIG.screenHeight);
  config.canvasFontFingerprint = toInteger(config.canvasFontFingerprint, DEFAULT_CONFIG.canvasFontFingerprint);
  config.readyStaggerMs = toInteger(config.readyStaggerMs, DEFAULT_CONFIG.readyStaggerMs);
  config.multiBackline = config.multiBackline === true;
  config.attackPercent = Math.min(100, Math.max(0, Number.isFinite(Number(config.attackPercent)) ? Number(config.attackPercent) : 100));
  config.testMode = config.testMode === true;

  if (!config.username) {
    throw new Error('config.json username must not be empty');
  }
  if (config.whichGameMode < 0 || config.whichGameMode > 3) {
    throw new Error('config.json whichGameMode must be between 0 and 3');
  }
  if (!config.authServerUrl) {
    throw new Error('config.json authServerUrl must not be empty');
  }
  if (config.botProcesses < 0) {
    throw new Error('config.json botProcesses must be 0 or greater');
  }
  if (config.buildNumber < 0 || config.buildNumber > 16383) {
    throw new Error('config.json buildNumber must be between 0 and 16383');
  }
  if (config.platformId < 0 || config.platformId > 15) {
    throw new Error('config.json platformId must be between 0 and 15');
  }
  if (config.platformVersion < 0 || config.platformVersion > 127) {
    throw new Error('config.json platformVersion must be between 0 and 127');
  }
  if (config.screenWidth < 0 || config.screenHeight < 0) {
    throw new Error('config.json screenWidth and screenHeight must be 0 or greater');
  }
  if (config.canvasFontFingerprint < 0 || config.canvasFontFingerprint > 16383) {
    throw new Error('config.json canvasFontFingerprint must be between 0 and 16383');
  }
  if (config.readyStaggerMs < 0) {
    throw new Error('config.json readyStaggerMs must be 0 or greater');
  }

  return config;
}

module.exports = {
  DEFAULT_CONFIG,
  getAppDir,
  loadConfig,
};
