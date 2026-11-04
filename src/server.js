import { createServer as createHttpServer } from 'node:http';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDatabase, seedDemo } from './db.js';
import { reconcile } from './reconcile.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

function reply(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function validSignature(body, signature, secret) {
  const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  const received = String(signature || '');
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(request) {
  let body = '';
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 65536) throw new Error('Payload too large');
    body += chunk;
  }
  return body;
}

function settlementCandidate(db, orderId) {
  if (typeof orderId !== 'string' || !orderId.trim()) throw new Error('orderId is required');
  const before = reconcile(db);
  const row = before.rows.find(item => item.orderId === orderId);
  if (!row) throw new Error('Order not found');
  if (!row.diagnosis.canPreviewSettlement) throw new Error('This order has no positive settlement gap to preview');
  return { before, row, amountPaise: row.diagnosis.settlementGapPaise };
}

function previewSettlement(db, orderId) {
  const { before, row, amountPaise } = settlementCandidate(db, orderId);
  db.exec('SAVEPOINT settlement_preview');
  try {
    db.prepare('INSERT INTO settlements VALUES (?, ?, ?)').run(`preview_${randomUUID()}`, row.paymentIds[0], amountPaise);
    const after = reconcile(db);
    return {
      orderId,
      amountPaise,
      before: { status: row.status, exceptions: before.summary.exceptions, impactPaise: row.diagnosis.impactPaise },
      after: { status: after.rows.find(item => item.orderId === orderId).status, exceptions: after.summary.exceptions, impactPaise: after.rows.find(item => item.orderId === orderId).diagnosis.impactPaise },
      disclaimer: 'Preview only. Record a settlement only after confirming the payout externally.',
    };
  } finally {
    db.exec('ROLLBACK TO settlement_preview; RELEASE settlement_preview');
  }
}

function applyDemoSettlement(db, orderId) {
  const { row, amountPaise } = settlementCandidate(db, orderId);
  db.prepare('INSERT INTO settlements VALUES (?, ?, ?)').run(`demo_${randomUUID()}`, row.paymentIds[0], amountPaise);
  return reconcile(db);
}

function ingestEvent(db, event) {
  if (!event || typeof event.id !== 'string' || typeof event.type !== 'string' || !event.data) {
    throw new Error('Event requires id, type and data');
  }
  if (db.prepare('SELECT id FROM webhook_events WHERE id = ?').get(event.id)) return { replayed: true };
  const data = event.data;
  const validAmount = Number.isSafeInteger(data.amountPaise) && data.amountPaise > 0;
  if (!validAmount) throw new Error('amountPaise must be a positive integer');
  db.exec('BEGIN');
  try {
    if (event.type === 'settlement.paid') {
      if (!data.id || !data.paymentId) throw new Error('Settlement needs id and paymentId');
      db.prepare('INSERT INTO settlements VALUES (?, ?, ?)').run(data.id, data.paymentId, data.amountPaise);
    } else if (event.type === 'refund.created') {
      if (!data.id || !data.paymentId) throw new Error('Refund needs id and paymentId');
      db.prepare('INSERT INTO refunds VALUES (?, ?, ?)').run(data.id, data.paymentId, data.amountPaise);
    } else if (event.type === 'payment.captured') {
      if (!data.id || !data.orderId) throw new Error('Payment needs id and orderId');
      db.prepare('INSERT INTO payments VALUES (?, ?, ?, ?)').run(data.id, data.orderId, data.amountPaise, 'captured');
    } else {
      throw new Error('Unsupported event type');
    }
    db.prepare('INSERT INTO webhook_events (id, type) VALUES (?, ?)').run(event.id, event.type);
    db.exec('COMMIT');
    return { replayed: false };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function createApp({ dbPath = join(ROOT, 'data', 'demo.sqlite'), secret = 'local-demo-secret' } = {}) {
  const db = openDatabase(dbPath);
  if (db.prepare('SELECT COUNT(*) AS count FROM orders').get().count === 0) seedDemo(db);
  const server = createHttpServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    try {
      if (request.method === 'GET' && path === '/api/dashboard') {
        reply(response, 200, reconcile(db));
        return;
      }
      if (request.method === 'POST' && path === '/api/demo/reset') {
        seedDemo(db);
        reply(response, 200, reconcile(db));
        return;
      }
      if (request.method === 'POST' && path === '/api/demo/resolve-late-payout') {
        db.prepare('INSERT OR IGNORE INTO settlements VALUES (?, ?, ?)').run('set_102', 'pay_102', 90000);
        reply(response, 200, reconcile(db));
        return;
      }
      if (request.method === 'POST' && path === '/api/demo/preview-settlement') {
        const { orderId } = JSON.parse(await readBody(request));
        reply(response, 200, previewSettlement(db, orderId));
        return;
      }
      if (request.method === 'POST' && path === '/api/demo/apply-settlement') {
        const { orderId } = JSON.parse(await readBody(request));
        reply(response, 200, applyDemoSettlement(db, orderId));
        return;
      }
      if (request.method === 'POST' && path === '/api/webhooks/payment') {
        const raw = await readBody(request);
        if (!validSignature(raw, request.headers['x-demo-signature'], secret)) {
          reply(response, 401, { error: 'Invalid webhook signature' });
          return;
        }
        const result = ingestEvent(db, JSON.parse(raw));
        reply(response, 200, result);
        return;
      }
      if (request.method === 'GET' && STATIC[path]) {
        const [file, contentType] = STATIC[path];
        const content = await readFile(join(ROOT, 'public', file));
        response.writeHead(200, { 'content-type': contentType });
        response.end(content);
        return;
      }
      reply(response, 404, { error: 'Not found' });
    } catch (error) {
      reply(response, 400, { error: error.message });
    }
  });
  return { server, db };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT || 4321);
  const { server } = createApp({ secret: process.env.WEBHOOK_SECRET || 'local-demo-secret' });
  server.listen(port, '127.0.0.1', () => process.stdout.write('Payment Reconciliation Lab: http://localhost:' + port + '\n'));
}
