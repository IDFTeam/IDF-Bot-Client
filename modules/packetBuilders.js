const DataWrapper = require('./DataWrapper');
const Base64NameEncoder = require('./Base64NameEncoder');
const {
  getPlayerColorId,
  getPlayerColorArray,
  writeUsername,
  writeScreenFingerprint
} = require('./utils');

const INIT_PACKET_BITS = 14 + 4 + 7 + 1 + 1 + 5 + 2 * 8;
const SCREEN_HASH_BITS = 15 * 6 + 14 + 7 + 12;

function getTimeZoneSomething() {
  const offset = new Date().getTimezoneOffset();
  return Math.abs(Math.floor((900 + offset + 0.5) / 15)) & 127;
}

function getScreenSizeHash(screenWidth = 1920, screenHeight = 1080) {
  const width = Number.isFinite(screenWidth) ? screenWidth & 0xFFF : 1920;
  const height = Number.isFinite(screenHeight) ? screenHeight & 0xFFF : 1080;
  return (width ^ height) & 0xFFF;
}

function writeInitPayload(dw, gameState = {}, platform = {}) {
  const translationInfo = Array.isArray(gameState.translationInfo)
    ? gameState.translationInfo
    : [0, 0];
  const isNotTerritorialDomain = gameState.isNotTerritorialDomain !== undefined
    ? gameState.isNotTerritorialDomain
    : !gameState.isTerritorialDomain;

  dw.writeBits(14, gameState.buildNumber ?? 1122);
  dw.writeBits(4, platform.id ?? 0);
  dw.writeBits(7, platform.version ?? 0);
  dw.writeBits(1, +isNotTerritorialDomain);
  dw.writeBits(1, +gameState.isInIframe);
  dw.writeBits(5, new Date().getHours() % 24);
  dw.writeBits(8, translationInfo[0] ?? 0);
  dw.writeBits(8, translationInfo[1] ?? 0);
}

function writeScreenHash(dw, options = {}) {
  const encoder = new Base64NameEncoder();
  const lastChallengeSolved = options.lastChallengeSolved ?? '';
  const canvasFontFingerprint = Number.isInteger(options.canvasFontFingerprint)
    ? options.canvasFontFingerprint
    : 0;
  const timeZoneSomething = Number.isInteger(options.timeZoneSomething)
    ? options.timeZoneSomething
    : getTimeZoneSomething();

  encoder.writeFixedLengthString(dw, lastChallengeSolved, 15);
  dw.writeBits(14, canvasFontFingerprint & 16383);
  dw.writeBits(7, timeZoneSomething & 127);
  dw.writeBits(12, getScreenSizeHash(options.screenWidth, options.screenHeight));
}

function buildInitPacket(gameState, platform, screenHashOptions = {}) {
  const dw = new DataWrapper();
  const totalBits = 1 + 6 + INIT_PACKET_BITS + SCREEN_HASH_BITS;

  dw.allocateAndInitialize(totalBits);

  dw.writeBits(1, 0);
  dw.writeBits(6, 13);
  writeInitPayload(dw, gameState, platform);
  writeScreenHash(dw, screenHashOptions);

  return dw.buffer;
}

function buildAccountPacket(account, password) {
  const dw = new DataWrapper();
  const encoder = new Base64NameEncoder();

  const totalBits = 1 + 6 + 30 + 90;

  dw.allocateAndInitialize(totalBits);
  dw.writeBits(1, 0);
  dw.writeBits(6, 17);

  encoder.writeFixedLengthString(dw, account, 5);
  encoder.writeFixedLengthString(dw, password, 15);
  return dw.buffer;
}

function buildChallengeResponsePacket(challengeResponse, eventType = 0) {
  const dw = new DataWrapper();
  dw.allocateAndInitialize(1 + 6 + 3 + 30);
  dw.writeBits(1, 0);
  dw.writeBits(6, 30);
  dw.writeBits(3, eventType);
  dw.writeBits(30, challengeResponse);
  return dw.buffer;
}

function buildExecutableChallengeResponse(challengeResponse, executableResult) {
  const dw = new DataWrapper();
  dw.allocateAndInitialize(1 + 6 + 30 + 16);
  dw.writeBits(1, 0);
  dw.writeBits(6, 31);
  dw.writeBits(30, challengeResponse);
  dw.writeBits(16, executableResult);
  return dw.buffer;
}

function buildLobbyJoinPacket(username, whichGameMode, rgbInt, screenWidth, screenHeight, timeBasedSeed) {
  username = username.slice(0, 20);

  const playerColorId = getPlayerColorId(rgbInt);
  const playerColor = getPlayerColorArray(playerColorId);

  const totalBits = 1 + 6 + 10 + 2 + 5 + username.length * 16 + 18;

  const dw = new DataWrapper();
  dw.allocateAndInitialize(totalBits);

  dw.writeBits(1, 0);
  dw.writeBits(6, 1);
  dw.writeBits(10, 940);
  dw.writeBits(2, whichGameMode);

  writeUsername(dw, username);

  dw.writeBits(6, playerColor[0]);
  dw.writeBits(6, playerColor[1]);
  dw.writeBits(6, playerColor[2]);


  return dw.buffer;
}

function buildGamePacket(aEc, myId, timeBasedSeed, buildNumber) {
  const dw = new DataWrapper();
  dw.allocateAndInitialize(1 + 6 + 8 + 10 + 9 + 10 + 14);
  dw.writeBits(1, 0);
  dw.writeBits(6, 5);
  dw.writeBits(8, 1);
  dw.writeBits(10, aEc);
  dw.writeBits(9, myId);
  dw.writeBits(10, 940);
  dw.writeBits(14, buildNumber);
  return dw.buffer;
}

function buildSpawnPacket(tileIndex) {
  const dw = new DataWrapper();
  dw.allocateAndInitialize(1 + 4 + 22);
  dw.writeBits(1, 1);
  dw.writeBits(4, 0);
  dw.writeBits(22, tileIndex);
  return dw.buffer;
}

function buildAttackPacket(unitRatio, targetPlayer) {
  const dw = new DataWrapper();
  dw.allocateAndInitialize(1 + 4 + 10 + 10);
  dw.writeBits(1, 1);
  dw.writeBits(4, 1);
  dw.writeBits(10, unitRatio);
  dw.writeBits(10, targetPlayer);
  return dw.buffer;
}

function buildKeepaliveResponse(preimage) {
  return buildChallengeResponsePacket(preimage, 0);
}

function buildDonationPacket(unitRatio, targetPlayer) {
  const dw = new DataWrapper();
  dw.allocateAndInitialize(1 + 4 + 10 + 9);
  dw.writeBits(1, 1);
  dw.writeBits(4, 2);
  dw.writeBits(10, unitRatio);
  dw.writeBits(9, targetPlayer);
  return dw.buffer;
}

module.exports = {
  buildInitPacket,
  buildAccountPacket,
  buildChallengeResponsePacket,
  buildExecutableChallengeResponse,
  buildLobbyJoinPacket,
  buildGamePacket,
  buildSpawnPacket,
  buildAttackPacket,
  buildDonationPacket,
  buildKeepaliveResponse,
};
