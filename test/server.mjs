// Yerel test sunucusu: Worker'ı Node içinde, D1 yerine SQLite ile çalıştırır.
// Kullanım: node test/server.mjs <port> <db-dosyası> <pw_hash>
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.js';

const [port = '8787', dbFile = ':memory:', pwHash = ''] = process.argv.slice(2);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const sqlite = new DatabaseSync(dbFile);
sqlite.exec(fs.readFileSync(path.join(ROOT, 'migrations/0001_init.sql'), 'utf8'));
if (pwHash) sqlite.prepare("INSERT OR REPLACE INTO settings (k, v) VALUES ('pw_hash', ?)").run(pwHash);

class Stmt {
  constructor(sql, params = []) { this.sql = sql; this.params = params; }
  bind(...p) { return new Stmt(this.sql, p); }
  _s() { return sqlite.prepare(this.sql); }
  async first(col) { const r = this._s().get(...this.params); return r == null ? null : col ? r[col] : { ...r }; }
  async all() { return { results: this._s().all(...this.params).map((r) => ({ ...r })) }; }
  async run() { const r = this._s().run(...this.params); return { meta: { changes: r.changes } }; }
  _runSync() { return this._s().run(...this.params); }
}
const DB = {
  prepare: (sql) => new Stmt(sql),
  async batch(stmts) {
    sqlite.exec('BEGIN');
    try { const out = stmts.map((s) => s._runSync()); sqlite.exec('COMMIT'); return out; }
    catch (e) { sqlite.exec('ROLLBACK'); throw e; }
  },
};
const ASSETS = {
  async fetch(req) {
    const u = new URL(req.url);
    const f = path.join(ROOT, 'public', path.normalize(u.pathname));
    if (!f.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return new Response('Not found', { status: 404 });
    const body = fs.readFileSync(f);
    const etag = '"' + crypto.createHash('md5').update(body).digest('hex') + '"';
    if (req.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
    return new Response(body, { headers: { 'Content-Type': f.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream', ETag: etag } });
  },
};
const env = { DB, ASSETS };

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  const request = new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
  const waits = [];
  const delay = Number(process.env.NK_DELAY || 0);
  if (delay) await new Promise((r) => setTimeout(r, delay));
  try {
    const r = await worker.fetch(request, env, { waitUntil: (p) => waits.push(p) });
    const h = {};
    r.headers.forEach((v, k) => { h[k] = k === 'set-cookie' ? v : v; });
    res.writeHead(r.status, h);
    res.end(r.body ? Buffer.from(await r.arrayBuffer()) : undefined);
  } catch (e) {
    console.error(e);
    res.writeHead(500); res.end(String(e));
  }
  await Promise.allSettled(waits);
}).listen(Number(port), () => console.log('listening', port));
