const DataWrapper = require('./DataWrapper');

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getPlayerColorId(rgbInt) {
  const fX = clamp(rgbInt, -1, 262143);
  return fX === -1 ? ~~(Math.random() * 262144) : fX;
}

function getPlayerColorArray(playerColorId) {
  return [(playerColorId >> 12) & 63, (playerColorId >> 6) & 63, playerColorId & 63];
}

function writeUsername(dw, username) {
  dw.writeBits(5, username.length);
  for (let i = 0; i < username.length; i++) {
    dw.writeBits(16, username.charCodeAt(i));
  }
}

function writeScreenFingerprint(dw, screenWidth = 1920, screenHeight = 1080) {
  dw.writeBits(26, (screenWidth * screenHeight + screenHeight) % 67108864);
  dw.writeBits(22, 0);
  dw.writeBits(21, 0);
}

function sendPacket(label, buffer, socket) {
  if (process.env.LOG_PACKETS === '1') {
    console.log(`Sending [${label}]:`, Buffer.from(buffer).toString('hex'));
  }
  socket.send(buffer);
}

module.exports = {
  clamp,
  getPlayerColorId,
  getPlayerColorArray,
  writeUsername,
  writeScreenFingerprint,
  sendPacket,
};
