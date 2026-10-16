// Node's test/common/net.js (v24.21.0), but for hasMultiLocalhost, which Node answers with its
// internal TCP binding: whether the reusePort option works, and its options.
'use strict';
const net = require('net');

const options = { port: 0, reusePort: true };

function checkSupportReusePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer().listen(options);
    server.on('listening', () => {
      server.close(resolve);
    });
    server.on('error', (err) => {
      console.log('The `reusePort` option is not supported:', err.message);
      server.close();
      reject(err);
    });
  });
}

function hasMultiLocalhost() {
  // Node's binds 127.0.0.2 with its internal TCP handle; only Linux routes all of 127/8 to lo
  return process.platform === 'linux';
}

module.exports = {
  checkSupportReusePort,
  hasMultiLocalhost,
  options,
};
