import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec([
    'CREATE TABLE IF NOT EXISTS orders (',
    'id TEXT PRIMARY KEY, merchant TEXT NOT NULL,',
    'amount_paise INTEGER NOT NULL CHECK (amount_paise > 0));',
    'CREATE TABLE IF NOT EXISTS payments (',
    'id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id),',
    'amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),',
    "status TEXT NOT NULL CHECK (status IN ('captured', 'failed')));",
    'CREATE TABLE IF NOT EXISTS refunds (',
    'id TEXT PRIMARY KEY, payment_id TEXT NOT NULL REFERENCES payments(id),',
    'amount_paise INTEGER NOT NULL CHECK (amount_paise > 0));',
    'CREATE TABLE IF NOT EXISTS settlements (',
    'id TEXT PRIMARY KEY, payment_id TEXT NOT NULL REFERENCES payments(id),',
    'amount_paise INTEGER NOT NULL CHECK (amount_paise > 0));',
    'CREATE TABLE IF NOT EXISTS webhook_events (',
    'id TEXT PRIMARY KEY, type TEXT NOT NULL,',
    'received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);',
  ].join(' '));
  return db;
}

export function seedDemo(db) {
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM webhook_events; DELETE FROM settlements; DELETE FROM refunds; DELETE FROM payments; DELETE FROM orders');
    const order = db.prepare('INSERT INTO orders VALUES (?, ?, ?)');
    const payment = db.prepare('INSERT INTO payments VALUES (?, ?, ?, ?)');
    const refund = db.prepare('INSERT INTO refunds VALUES (?, ?, ?)');
    const settlement = db.prepare('INSERT INTO settlements VALUES (?, ?, ?)');
    [
      ['ord_101', 'Northwind Books', 120000],
      ['ord_102', 'Orchid Coffee', 90000],
      ['ord_103', 'Pine Retail', 150000],
      ['ord_104', 'Cedar Fitness', 200000],
      ['ord_105', 'Lotus Market', 85000],
      ['ord_106', 'Maple Studio', 300000],
    ].forEach(row => order.run(...row));
    [
      ['pay_101', 'ord_101', 120000, 'captured'],
      ['pay_102', 'ord_102', 90000, 'captured'],
      ['pay_103', 'ord_103', 140000, 'captured'],
      ['pay_104a', 'ord_104', 200000, 'captured'],
      ['pay_104b', 'ord_104', 200000, 'captured'],
      ['pay_105', 'ord_105', 85000, 'captured'],
      ['pay_106', 'ord_106', 300000, 'captured'],
    ].forEach(row => payment.run(...row));
    refund.run('ref_105', 'pay_105', 20000);
    [
      ['set_101', 'pay_101', 120000],
      ['set_103', 'pay_103', 140000],
      ['set_104a', 'pay_104a', 200000],
      ['set_104b', 'pay_104b', 200000],
      ['set_105', 'pay_105', 65000],
      ['set_106', 'pay_106', 295000],
    ].forEach(row => settlement.run(...row));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
