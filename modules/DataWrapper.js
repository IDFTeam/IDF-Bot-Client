class DataWrapper {
  constructor() {
    this.size = 0;
    this.bitPosition = 0;
    this.buffer = null;
  }

  init(buffer) {
    this.bitPosition = 0;
    this.buffer = buffer;
    this.size = buffer.length;
  }

  allocateAndInitialize(totalBits) {
    this.init(new Uint8Array((totalBits + 7) >> 3));
    return this.buffer;
  }

  writeBits(bitCount, value) {
    const end = this.bitPosition + bitCount - 1;

    for (let i = this.bitPosition; i <= end; i++) {
      this.buffer[i >> 3] |=
        ((value >> (end - i)) & 1) << (7 - (i & 7));
    }

    this.bitPosition += bitCount;

    if (this.bitPosition > 8 * this.size) {
      console.error("Wrapper Overflow");
    }
  }
}

module.exports = DataWrapper;