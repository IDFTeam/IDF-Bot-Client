class HashGenerator {
  constructor() {
    this.BUFFER_SIZE = 256;
  }

  generateHash(seedA, seedB) {
    const buffer = new Uint8Array(this.BUFFER_SIZE);

    let prngX = 3 + (4 + seedA) % 32768;
    let prngY = 12 + seedB % 32768;
    let prngZ = 17 + ((seedA & seedB) + (seedA | seedB) + seedA) % 32768;

    for (let i = 0; i < this.BUFFER_SIZE; i++) {
      prngX = 1 + (prngX * prngY) % prngZ;
      buffer[i] = prngX % 256;
    }

    for (let i = 0; i < this.BUFFER_SIZE; i++) {
      buffer[i] = (buffer[i] + ((seedA >> ((i + 2) % 30)) & 1)) % 256;
      buffer[i] = (buffer[i] + ((seedB >> ((i + 7) % 30)) & 1)) % 256;
    }

    let pos = 0;
    for (let i = 0; i < 30000; i++) {
      let temp = buffer[pos];
      buffer[pos] = (temp + i + buffer[(pos + i) % 256]) % 256;
      pos = (temp + i + pos + (temp & pos)) % 256;
    }

    let h1 = 1, h2 = 1;

    for (let i = 0; i < this.BUFFER_SIZE; i += 2) {
      h1 = ((1 + h1) * (buffer[i] + 1)) % 1073741824;
      h2 = ((1 + h2) * (buffer[i + 1] + 1)) % 1073741824;
    }

    return [h1, h2];
  }

  bruteForceFindPreimage(bitLength, seedA, seedB, targetHash) {
    const cacheKey = `${bitLength}:${seedA}:${seedB}:${targetHash}`;
    const cached = HashGenerator.preimageCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const max = 1 << bitLength;
    for (let i = 0; i < max; i++) {
      let tempL = seedA + i;
      let tempU = seedB + i;
      let hash = (tempL + tempU) & 2147483647;

      for (let round = 1; round <= 16; round++) {
        hash ^= hash >> round;
        hash >>>= 1 + (tempL & 3);
        hash = (hash * (7 + ((tempL | tempU) & 1023))) & 1073741823;
        hash += tempU & 65535;
        tempL >>= 1 + (hash & 1);
        tempU >>= 1 + (tempL & 1);
      }

      if ((hash & 1073741823) === targetHash) {
        HashGenerator.rememberPreimage(cacheKey, i);
        return i;
      }
    }
    HashGenerator.rememberPreimage(cacheKey, 0);
    return 0;
  }

  computeMixedHash(inputValue, seedA, seedB) {
    let tempL = seedA + inputValue;
    let tempU = seedB + inputValue;

    let hash = (tempL + tempU) & 2147483647;

    for (let i = 1; i <= 16; i++) {
      hash ^= hash >> i;
      hash >>>= 1 + (tempL & 3);
      hash = (hash * (7 + ((tempL | tempU) & 1023))) & 1073741823;
      hash += (tempU & 65535);
      tempL >>= 1 + (hash & 1);
      tempU >>= 1 + (tempL & 1);
    }

    return hash & 1073741823;
  }

  static rememberPreimage(cacheKey, value) {
    if (HashGenerator.preimageCache.size >= HashGenerator.MAX_PREIMAGE_CACHE_SIZE) {
      const oldestKey = HashGenerator.preimageCache.keys().next().value;
      HashGenerator.preimageCache.delete(oldestKey);
    }
    HashGenerator.preimageCache.set(cacheKey, value);
  }
}

HashGenerator.MAX_PREIMAGE_CACHE_SIZE = 512;
HashGenerator.preimageCache = new Map();

module.exports = HashGenerator;
