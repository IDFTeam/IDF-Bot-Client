const vm = require('vm');
const fs = require('fs');
const path = require('path');
const HashGenerator = require('./HashGenerator');
const { getAppDir } = require('./config');

const CANVAS_FONT_FINGERPRINT = 9794;

// ── Executable challenge result cache ────────────────────────────────────────

const SEED_CACHE_PATH = path.join(getAppDir(), 'seed.json');
let executableCache = null;

function loadExecutableCache() {
  if (executableCache) return executableCache;
  try {
    executableCache = JSON.parse(fs.readFileSync(SEED_CACHE_PATH, 'utf8'));
  } catch {
    executableCache = {};
  }
  return executableCache;
}

function saveExecutableCache() {
  try {
    // Read the current file fresh, merge in-memory cache on top, then write.
    // This prevents concurrent processes from overwriting each other's entries.
    let onDisk = {};
    try {
      onDisk = JSON.parse(fs.readFileSync(SEED_CACHE_PATH, 'utf8'));
    } catch {
      // file doesn't exist yet or is corrupt — start fresh
    }
    // Merge: disk wins for existing keys, in-memory adds new keys
    const merged = { ...onDisk, ...executableCache };
    fs.writeFileSync(SEED_CACHE_PATH, JSON.stringify(merged, null, 2), 'utf8');
    // Update in-memory cache to reflect merged state so next save is accurate
    executableCache = merged;
  } catch (e) {
    console.warn('[SeedCache] Failed to save seed.json:', e.message);
  }
}

function getCachedResult(challengeCode) {
  const cache = loadExecutableCache();
  const entry = cache[challengeCode];
  if (entry !== undefined) return entry;
  return null;
}

function setCachedResult(challengeCode, result) {
  const cache = loadExecutableCache();
  if (cache[challengeCode] === result) return; // already stored
  cache[challengeCode] = result;
  saveExecutableCache();
}

function solveChallenge(reader) {
  const eventType = reader.readBits(3);
  const difficultyBits = reader.readBits(5);
  const seedA = reader.readBits(30);
  const seedB = reader.readBits(30);
  const targetHash = reader.readBits(30);
  const hashGen = new HashGenerator();
  const challengeResponse = hashGen.bruteForceFindPreimage(difficultyBits, seedA, seedB, targetHash);

  return {
    eventType,
    difficultyBits,
    challengeResponse,
  };
}

function solveLegacyKeepaliveChallenge(reader) {
  const difficultyBits = reader.readBits(5);
  const seedA = reader.readBits(30);
  const seedB = reader.readBits(30);
  const targetHash = reader.readBits(30);
  const hashGen = new HashGenerator();
  const challengeResponse = hashGen.bruteForceFindPreimage(difficultyBits, seedA, seedB, targetHash);

  return {
    eventType: 0,
    difficultyBits,
    challengeResponse,
  };
}

function runExecutableChallengeCode(challengeCode) {
  const script = new vm.Script(`(function () {\n${challengeCode}\n})()`);
  const value = script.runInNewContext(createExecutableChallengeSandbox(), { timeout: 100 });
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return 0;
  }

  return numericValue & 0xFFFF;
}

function noop() {
}

function createCanvas2dContext() {
  return {
    canvas: null,
    fillStyle: '#000000',
    strokeStyle: '#000000',
    font: '10px sans-serif',
    fontKerning: 'auto',
    fontStretch: 'normal',
    fontVariantCaps: 'normal',
    letterSpacing: '0px',
    textRendering: 'auto',
    wordSpacing: '0px',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    lineDashOffset: 0,
    miterLimit: 10,
    shadowBlur: 0,
    shadowColor: 'rgba(0, 0, 0, 0)',
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    direction: 'inherit',
    filter: 'none',
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'low',
    save: noop,
    restore: noop,
    scale: noop,
    rotate: noop,
    translate: noop,
    transform: noop,
    setTransform: noop,
    resetTransform: noop,
    getTransform: () => createDomMatrix(),
    clearRect: noop,
    fillRect: noop,
    strokeRect: noop,
    reset: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    bezierCurveTo: noop,
    quadraticCurveTo: noop,
    arc: noop,
    arcTo: noop,
    ellipse: noop,
    rect: noop,
    roundRect: noop,
    fill: noop,
    stroke: noop,
    clip: noop,
    setLineDash: noop,
    getLineDash: () => [],
    isPointInPath: () => false,
    isPointInStroke: () => false,
    fillText: noop,
    strokeText: noop,
    measureText: () => ({ width: 0 }),
    drawImage: noop,
    drawFocusIfNeeded: noop,
    createImageData: (width, height) => ({
      width,
      height,
      data: new Uint8ClampedArray(Math.max(0, width * height * 4)),
    }),
    getImageData: (x, y, width, height) => createFingerprintImageData(width, height),
    putImageData: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createConicGradient: () => ({ addColorStop: noop }),
    createPattern: () => null,
  };
}

function createDomMatrix() {
  return {
    a: 1,
    b: 0,
    c: 0,
    d: 1,
    e: 0,
    f: 0,
    is2D: true,
    isIdentity: true,
    multiply: () => createDomMatrix(),
    multiplySelf: () => createDomMatrix(),
    inverse: () => createDomMatrix(),
    invertSelf: () => createDomMatrix(),
    translate: () => createDomMatrix(),
    translateSelf: () => createDomMatrix(),
    scale: () => createDomMatrix(),
    scaleSelf: () => createDomMatrix(),
    rotate: () => createDomMatrix(),
    rotateSelf: () => createDomMatrix(),
    transformPoint: (point) => point,
    toFloat32Array: () => new Float32Array([1, 0, 0, 1, 0, 0]),
    toFloat64Array: () => new Float64Array([1, 0, 0, 1, 0, 0]),
    toString: () => 'matrix(1, 0, 0, 1, 0, 0)',
  };
}

function createWebglContext() {
  return {
    canvas: null,
    drawingBufferWidth: 1920,
    drawingBufferHeight: 1080,
    getParameter: () => 0,
    getExtension: () => null,
    getSupportedExtensions: () => [],
    clearColor: noop,
    clear: noop,
    viewport: noop,
    createBuffer: () => ({}),
    bindBuffer: noop,
    bufferData: noop,
    createShader: () => ({}),
    shaderSource: noop,
    compileShader: noop,
    getShaderParameter: () => true,
    createProgram: () => ({}),
    attachShader: noop,
    linkProgram: noop,
    getProgramParameter: () => true,
    useProgram: noop,
    getAttribLocation: () => 0,
    getUniformLocation: () => ({}),
    enableVertexAttribArray: noop,
    vertexAttribPointer: noop,
    uniform1f: noop,
    uniform2f: noop,
    uniform3f: noop,
    uniform4f: noop,
    drawArrays: noop,
    readPixels: noop,
  };
}

function createFingerprintImageData(width, height) {
  const data = new Uint8ClampedArray(Math.max(0, width * height * 4));
  let remaining = CANVAS_FONT_FINGERPRINT;

  for (let i = 0; i < data.length && remaining > 0; i += 4) {
    const value = Math.min(255, remaining);
    data[i] = value;
    remaining -= value;
  }

  return { width, height, data };
}

function createCanvasElement() {
  const context2d = createCanvas2dContext();
  const webglContext = createWebglContext();
  const canvas = {
    width: 300,
    height: 150,
    style: {},
    getContext(type) {
      const contextType = String(type).toLowerCase();
      if (contextType === '2d') return context2d;
      if (contextType === 'webgl' || contextType === 'experimental-webgl') return webglContext;
      return null;
    },
    toDataURL: () => 'data:image/png;base64,',
    toBlob: noop,
    captureStream: () => ({}),
    transferControlToOffscreen: () => createCanvasElement(),
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: () => true,
    setAttribute(name, value) {
      this[name] = value;
    },
    getAttribute(name) {
      return this[name] ?? null;
    },
  };
  context2d.canvas = canvas;
  webglContext.canvas = canvas;
  return canvas;
}

function createExecutableChallengeSandbox() {
  const sandbox = {
    Uint8ClampedArray,
    Math,
    Date,
    Number,
    String,
    Boolean,
    Array,
    Object,
    RegExp,
    JSON,
    Uint8Array,
    parseInt,
    parseFloat,
    isFinite,
    isNaN,
    DOMMatrix: function DOMMatrix() {
      return createDomMatrix();
    },
    DOMMatrixReadOnly: function DOMMatrixReadOnly() {
      return createDomMatrix();
    },
    Path2D: function Path2D() {
    },
    ImageData: function ImageData(width, height) {
      return {
        width,
        height,
        data: new Uint8ClampedArray(Math.max(0, width * height * 4)),
      };
    },
    document: {
      createElement(tagName) {
        if (String(tagName).toLowerCase() === 'canvas') {
          return createCanvasElement();
        }
        return {
          style: {},
          appendChild: noop,
          removeChild: noop,
          setAttribute: noop,
          getAttribute: () => null,
        };
      },
      createElementNS(namespace, tagName) {
        return this.createElement(tagName);
      },
      body: {
        appendChild: noop,
        removeChild: noop,
      },
      documentElement: {
        style: {},
      },
    },
    navigator: {
      userAgent: 'Mozilla/5.0',
      language: 'en-US',
      languages: ['en-US', 'en'],
      platform: 'Win32',
      hardwareConcurrency: 8,
      maxTouchPoints: 0,
    },
    screen: {
      width: 1920,
      height: 1080,
      availWidth: 1920,
      availHeight: 1040,
      colorDepth: 24,
      pixelDepth: 24,
    },
    devicePixelRatio: 1,
  };

  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  return sandbox;
}

function solveExecutableChallenge(reader) {
  const difficultyBits = reader.readBits(5);
  const seedA = reader.readBits(30);
  const seedB = reader.readBits(30);
  const targetHash = reader.readBits(30);
  const hashGen = new HashGenerator();
  const challengeResponse = hashGen.bruteForceFindPreimage(difficultyBits, seedA, seedB, targetHash);
  const challengeCode = reader.decodeVarLengthString(16);

  let executableResult = getCachedResult(challengeCode);
  if (executableResult === null) {
    executableResult = runExecutableChallengeCode(challengeCode);
    setCachedResult(challengeCode, executableResult);
    console.log(`[SeedCache] New executable challenge cached (result=${executableResult})`);
  } else {
    console.log(`[SeedCache] Executable challenge result loaded from cache (result=${executableResult})`);
  }

  return {
    difficultyBits,
    challengeResponse,
    challengeCode,
    executableResult,
  };
}

module.exports = {
  solveChallenge,
  solveLegacyKeepaliveChallenge,
  solveExecutableChallenge,
};
