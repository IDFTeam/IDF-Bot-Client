class BitStreamReader {
  init(buffer) {
    this.buffer = buffer;
    this.size = buffer.length;
    this.bitPosition = 0;
  }

  readBits(size) {
    let value = 0;
    const end = this.bitPosition + size - 1;

    for (let i = this.bitPosition; i <= end; i++) {
      value |=
        ((this.buffer[i >> 3] >> (7 - (i & 7))) & 1) << (end - i);
    }

    this.bitPosition += size;

    if (this.bitPosition > 8 * this.size) {
      console.error("Reader Overflow");
    }

    return value;
  }

  decodeVarLengthString(sizeBits) {
    const size = this.readBits(sizeBits);
    const charBitWidth = 7 + 9 * this.readBits(1);
    const chars = [];
    for (let i = 0; i < size; i++) {
      chars.push(String.fromCharCode(this.readBits(charBitWidth)));
    }
    return chars.join('');
  }
}

module.exports = BitStreamReader;