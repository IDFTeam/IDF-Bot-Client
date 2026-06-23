class Base64NameEncoder {
  constructor() {
    this.charLookupTable = new Uint8Array(78);
    this.init();
  }

  init() {
    this.charLookupTable[50] = 37;
    for (let i = 0; i < 10; i++) {
      this.charLookupTable[i + 3] = i + 1;
    }
    for (let i = 0; i < 26; i++) {
      this.charLookupTable[i + 20] = i + 11;
      this.charLookupTable[i + 52] = i + 38;
    }
  }

  sanitizeUsername(str) {
    return str.trim().replace(/[^a-zA-Z0-9_\-]/g, '-');
  }

  padOrTrimToFixedSize(str, size) {
    str = this.sanitizeUsername(str);
    if (str.length > size) return str.substring(0, size);
    while (str.length < size) str = '-' + str;
    return str;
  }

  stringToLookupBytes(str) {
    const out = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
      out[i] = this.charLookupTable[str.charCodeAt(i) - 45];
    }
    return out;
  }

  writeFixedLengthString(dw, str, size) {
    const bytes = this.stringToLookupBytes(this.padOrTrimToFixedSize(str, size));
    for (let i = 0; i < bytes.length; i++) {
      dw.writeBits(6, bytes[i]);
    }
  }

  encodeStringToInt(str, size) {
    const bytes = this.stringToLookupBytes(this.padOrTrimToFixedSize(str, size));
    let result = 0;
    for (let i = 0; i < bytes.length; i++) {
      result = result * 64 + bytes[i];
    }
    return result;
  }
}

module.exports = Base64NameEncoder;
