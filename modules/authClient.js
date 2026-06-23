const crypto = require('crypto');
const http = require('http');
const https = require('https');
const os = require('os');
const readline = require('readline');
const { execFileSync } = require('child_process');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function runCommand(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
    }).trim();
  } catch (_) {
    return '';
  }
}

function getMachineGuid() {
  if (process.platform !== 'win32') return '';

  const output = runCommand('reg', [
    'query',
    'HKLM\\SOFTWARE\\Microsoft\\Cryptography',
    '/v',
    'MachineGuid',
  ]);
  const match = output.match(/MachineGuid\s+REG_\w+\s+([^\s]+)/i);
  return match ? match[1] : '';
}

function getBiosUuid() {
  if (process.platform !== 'win32') return '';

  const output = runCommand('wmic', ['csproduct', 'get', 'uuid']);
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !/^uuid$/i.test(line)) || '';
}

function getHwid() {
  const cpu = os.cpus()[0]?.model || '';
  const rawParts = [
    getMachineGuid(),
    getBiosUuid(),
    os.hostname(),
    os.userInfo().username,
    os.platform(),
    os.arch(),
    cpu,
  ];

  return sha256(rawParts.filter(Boolean).join('|'));
}

function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function postJson(urlString, payload, timeoutMs = 10000) {
  const url = new URL('/login', urlString);
  const body = Buffer.from(JSON.stringify(payload));
  const transport = url.protocol === 'https:' ? https : http;

  const options = {
    method: 'POST',
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: `${url.pathname}${url.search}`,
    headers: {
      'content-type': 'application/json',
      'content-length': body.length,
    },
    timeout: timeoutMs,
  };

  return new Promise((resolve, reject) => {
    const req = transport.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = {};
        try {
          data = text ? JSON.parse(text) : {};
        } catch (err) {
          reject(new Error(`Auth server returned invalid JSON: ${err.message}`));
          return;
        }

        if (res.statusCode < 200 || res.statusCode >= 300 || data.ok !== true) {
          reject(new Error(data.error || `Auth server rejected request with HTTP ${res.statusCode}`));
          return;
        }

        resolve(data);
      });
    });

    req.on('timeout', () => req.destroy(new Error('Auth server timed out')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function authenticateClient(config, options = {}) {
  const loginUsername = config.loginUsername || await ask('Login username: ');
  const loginPassword = config.loginPassword || await ask('Login password: ');
  const hwid = getHwid();
  const verbose = options.verbose === true;

  if (!loginUsername || !loginPassword) {
    throw new Error('Login username and password are required');
  }

  const response = await postJson(config.authServerUrl, {
    username: loginUsername,
    password: loginPassword,
    hwid,
    clientUsername: config.username,
    targetClan: config.targetClan,
  });

  if (verbose) {
    console.log(`[Auth] ${response.message || 'Login validated'}`);
  }
  return response;
}

module.exports = {
  authenticateClient,
  getHwid,
};
