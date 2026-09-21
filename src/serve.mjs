// Простой локальный просмотр собранного сайта: http://localhost:4173
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib/content.mjs';

const DIST = path.join(ROOT, 'dist');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json' };
const port = Number(process.env.PORT) || 4173;

http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path.join(DIST, p);
  if (!file.startsWith(DIST)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404, { 'content-type': TYPES['.html'] }); return res.end(fs.readFileSync(path.join(DIST, '404.html'))); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`Сайт открыт: http://localhost:${port}  (Ctrl+C, чтобы остановить)`));
