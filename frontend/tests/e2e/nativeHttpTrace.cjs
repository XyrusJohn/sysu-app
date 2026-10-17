const http = require('node:http');
if (process.env.SYSU_ENV !== 'emulator' || process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8085'
    || process.env.FIREBASE_AUTH_EMULATOR_HOST !== '127.0.0.1:9099') throw Error('Native HTTP tracing requires isolated emulators');
const createServer = http.createServer;
http.createServer = function (...args) {
  const server = createServer.apply(this,args);
  server.on('request',(request,response) => {
    if (request.method !== 'POST' || request.url !== '/api/qr/scan') return;
    const started = Date.now();
    console.log('[NATIVE_QR_HTTP] received');
    response.once('finish',() => console.log('[NATIVE_QR_HTTP] '+JSON.stringify({status:response.statusCode,elapsedMs:Date.now()-started})));
    response.once('close',() => {if (!response.writableFinished) console.log('[NATIVE_QR_HTTP] client disconnected before response');});
  });
  return server;
};
