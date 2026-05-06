/**
 * test/server.js — Local mock OCP console for testing OC Pilot features.
 *
 * Serves mock-console.html at ANY path so that location.pathname reflects
 * a real OCP URL (e.g. /k8s/ns/default/deployments).
 *
 * Run:  node test/server.js
 * Then open: http://localhost:8787/k8s/ns/default/deployments
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT     = 8787;
const ROOT     = path.dirname(__filename);
const HTML     = path.join(ROOT, 'mock-console.html');
const SCRIPT   = path.join(ROOT, '..', 'src', 'content-console.js');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Serve content-console.js directly so the mock page can <script src> it.
  if (url.pathname === '/__oc-pilot/content-console.js') {
    res.writeHead(200, { 'Content-Type': MIME['.js'] });
    res.end(fs.readFileSync(SCRIPT));
    return;
  }

  // Everything else → mock console HTML (so location.pathname = real OCP path).
  res.writeHead(200, { 'Content-Type': MIME['.html'] });
  res.end(fs.readFileSync(HTML));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  OC Pilot mock console running.\n`);
  console.log(`  Deployments list : http://localhost:${PORT}/k8s/ns/default/deployments`);
  console.log(`  All-namespaces   : http://localhost:${PORT}/k8s/all-namespaces/deployments`);
  console.log(`  Detail page      : http://localhost:${PORT}/k8s/ns/default/deployments/my-app\n`);
  console.log(`  Ctrl-C to stop.\n`);
});
