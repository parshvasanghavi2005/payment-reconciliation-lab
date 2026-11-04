import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { createApp } from '../src/server.js';
import { reconcile } from '../src/reconcile.js';

test('reconciles paid, refunded, delayed, duplicate and mismatched transactions', () => {
  const { db } = createApp({ dbPath: ':memory:' });
  const result = reconcile(db);
  assert.equal(result.summary.orders, 6);
  assert.equal(result.summary.matched, 2);
  assert.equal(result.summary.exceptions, 4);
  assert.deepEqual(result.rows.map(row => row.status), [
    'MATCHED',
    'UNSETTLED',
    'AMOUNT_MISMATCH',
    'DUPLICATE_PAYMENT',
    'MATCHED',
    'SETTLEMENT_MISMATCH',
  ]);
  assert.equal(result.rows[4].refundedPaise, 20000);
  assert.equal(result.rows[4].settledPaise, 65000);
  db.close();
});

test('dashboard, signed webhook and replay protection work end to end', async () => {
  const secret = 'test-secret';
  const { server, db } = createApp({ dbPath: ':memory:', secret });
  server.listen(0);
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Every rupee accounted for/);
    const initial = await (await fetch(base + '/api/dashboard')).json();
    assert.equal(initial.summary.exceptions, 4);

    const event = {
      id: 'evt_late_102',
      type: 'settlement.paid',
      data: { id: 'set_102', paymentId: 'pay_102', amountPaise: 90000 },
    };
    const body = JSON.stringify(event);
    const bad = await fetch(base + '/api/webhooks/payment', {
      method: 'POST', headers: { 'x-demo-signature': 'invalid' }, body,
    });
    assert.equal(bad.status, 401);

    const signature = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
    const send = () => fetch(base + '/api/webhooks/payment', {
      method: 'POST', headers: { 'x-demo-signature': signature }, body,
    });
    const accepted = await send();
    assert.deepEqual(await accepted.json(), { replayed: false });
    const repeated = await send();
    assert.deepEqual(await repeated.json(), { replayed: true });
    const updated = await (await fetch(base + '/api/dashboard')).json();
    assert.equal(updated.summary.exceptions, 3);
    assert.equal(updated.rows.find(row => row.orderId === 'ord_102').status, 'MATCHED');
  } finally {
    server.close();
    db.close();
  }
});

test('diagnosis covers missing captures, excess refunds, and fully refunded orders', () => {
  const { db } = createApp({ dbPath: ':memory:' });
  try {
    db.prepare('INSERT INTO orders VALUES (?, ?, ?)').run('ord_missing', 'Missing Merchant', 5000);
    db.prepare('INSERT INTO orders VALUES (?, ?, ?)').run('ord_refunded', 'Refunded Merchant', 10000);
    db.prepare('INSERT INTO payments VALUES (?, ?, ?, ?)').run('pay_refunded', 'ord_refunded', 10000, 'captured');
    db.prepare('INSERT INTO refunds VALUES (?, ?, ?)').run('ref_full', 'pay_refunded', 10000);
    db.prepare('INSERT INTO orders VALUES (?, ?, ?)').run('ord_excess', 'Excess Merchant', 10000);
    db.prepare('INSERT INTO payments VALUES (?, ?, ?, ?)').run('pay_excess', 'ord_excess', 10000, 'captured');
    db.prepare('INSERT INTO refunds VALUES (?, ?, ?)').run('ref_excess', 'pay_excess', 12000);
    const rows = reconcile(db).rows;
    const find = id => rows.find(row => row.orderId === id);
    assert.equal(find('ord_missing').status, 'MISSING_PAYMENT');
    assert.equal(find('ord_missing').diagnosis.impactPaise, 5000);
    assert.equal(find('ord_refunded').status, 'MATCHED');
    assert.equal(find('ord_refunded').diagnosis.impactPaise, 0);
    assert.equal(find('ord_excess').status, 'REFUND_EXCEEDS_PAYMENT');
    assert.equal(find('ord_excess').diagnosis.impactPaise, 2000);
  } finally { db.close(); }
});

test('settlement preview rolls back and applying closes only the selected exception', async () => {
  const { server, db } = createApp({ dbPath: ':memory:' });
  server.listen(0);
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (path, orderId) => fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orderId }),
  });
  try {
    const previewResponse = await post('/api/demo/preview-settlement', 'ord_106');
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json();
    assert.equal(preview.amountPaise, 5000);
    assert.deepEqual(preview.before, { status: 'SETTLEMENT_MISMATCH', exceptions: 4, impactPaise: 5000 });
    assert.deepEqual(preview.after, { status: 'MATCHED', exceptions: 3, impactPaise: 0 });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM settlements WHERE payment_id = ?').get('pay_106').count, 1);
    assert.equal((await (await fetch(base + '/api/dashboard')).json()).summary.exceptions, 4);

    const invalid = await post('/api/demo/preview-settlement', 'ord_104');
    assert.equal(invalid.status, 400);
    const applied = await post('/api/demo/apply-settlement', 'ord_106');
    assert.equal(applied.status, 200);
    const result = await applied.json();
    assert.equal(result.summary.exceptions, 3);
    assert.equal(result.rows.find(row => row.orderId === 'ord_106').status, 'MATCHED');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM settlements WHERE payment_id = ?').get('pay_106').count, 2);
    assert.equal((await post('/api/demo/apply-settlement', 'ord_106')).status, 400);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM settlements WHERE payment_id = ?').get('pay_106').count, 2);
  } finally {
    server.close();
    db.close();
  }
});
