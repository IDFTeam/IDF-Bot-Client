const https = require('https');
const net = require('net');
const tls = require('tls');

class HttpsProxyAgent extends https.Agent {
  constructor(proxyUrl, options = {}) {
    super(options);
    this.proxy = new URL(proxyUrl);
  }

  createConnection(options, callback) {
    const targetHost = options.host || options.hostname;
    const targetPort = options.port || 443;
    const proxyPort = Number.parseInt(this.proxy.port || '80', 10);
    const socket = net.connect(proxyPort, this.proxy.hostname);

    const fail = (err) => {
      socket.destroy();
      callback(err);
    };

    socket.setTimeout(options.timeout || 15000, () => {
      fail(new Error('Proxy connection timed out'));
    });

    socket.once('error', fail);
    socket.once('connect', () => {
      const headers = [
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
        `Host: ${targetHost}:${targetPort}`,
        'Connection: keep-alive',
      ];

      if (this.proxy.username || this.proxy.password) {
        const username = decodeURIComponent(this.proxy.username);
        const password = decodeURIComponent(this.proxy.password);
        const token = Buffer.from(`${username}:${password}`).toString('base64');
        headers.push(`Proxy-Authorization: Basic ${token}`);
      }

      socket.write(`${headers.join('\r\n')}\r\n\r\n`);
    });

    let response = Buffer.alloc(0);
    socket.on('data', function onProxyData(chunk) {
      response = Buffer.concat([response, chunk]);
      const endOfHeaders = response.indexOf('\r\n\r\n');
      if (endOfHeaders === -1) return;

      socket.removeListener('data', onProxyData);
      socket.removeListener('error', fail);

      const headerText = response.slice(0, endOfHeaders).toString('utf8');
      const firstLine = headerText.split('\r\n')[0] || '';
      const statusMatch = firstLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/i);
      const statusCode = statusMatch ? Number.parseInt(statusMatch[1], 10) : 0;

      if (statusCode !== 200) {
        fail(new Error(`Proxy CONNECT failed: ${firstLine}`));
        return;
      }

      const tlsSocket = tls.connect({
        socket,
        servername: options.servername || targetHost,
        ALPNProtocols: options.ALPNProtocols,
        rejectUnauthorized: options.rejectUnauthorized !== false,
      });

      tlsSocket.once('secureConnect', () => {
        tlsSocket.removeListener('error', callback);
        callback(null, tlsSocket);
      });
      tlsSocket.once('error', callback);
    });
  }
}

module.exports = { HttpsProxyAgent };
