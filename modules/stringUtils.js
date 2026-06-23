const reverseTable = new Array(64).fill('?');

reverseTable[0] = '-';

for (let i = 0; i < 10; i++) {
  reverseTable[i + 1] = String.fromCharCode(48 + i);
}

for (let i = 0; i < 26; i++) {
  reverseTable[i + 11] = String.fromCharCode(65 + i);
}

for (let i = 0; i < 26; i++) {
  reverseTable[i + 38] = String.fromCharCode(97 + i);
}

reverseTable[37] = '_';

function decodeFixedString(reader, length) {
  let result = '';

  for (let i = 0; i < length; i++) {
    const value = reader.readBits(6);
    result += reverseTable[value] || '?';
  }

  return result;
}

module.exports = { decodeFixedString, reverseTable };
