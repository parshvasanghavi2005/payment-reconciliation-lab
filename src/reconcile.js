function sum(rows, key) {
  return rows.reduce((total, row) => total + row[key], 0);
}

function diagnose(status, { order, captured, paid, refunded, settled, expectedNet }) {
  const settlementGap = expectedNet - settled;
  const capturedGap = order.amount_paise - paid;
  const impactPaise = Math.max(Math.abs(capturedGap), Math.abs(settlementGap), Math.max(0, refunded - paid));
  const details = {
    MATCHED: ['The captured amount and net settlement agree with the order.', 'No action needed.', 'NONE'],
    MISSING_PAYMENT: ['No captured payment is linked to this order.', 'Check the gateway capture and order reference.', 'HIGH'],
    DUPLICATE_PAYMENT: [`${captured.length} captures are linked to one order.`, 'Investigate the extra capture and arrange a reversal if confirmed.', 'HIGH'],
    AMOUNT_MISMATCH: ['The captured amount differs from the order amount.', 'Compare the gateway receipt with the order before adjusting funds.', 'HIGH'],
    REFUND_EXCEEDS_PAYMENT: ['Refunds exceed the captured amount.', 'Review refund events for duplicates or incorrect amounts.', 'HIGH'],
    UNSETTLED: ['A capture exists, but no funds have settled.', 'Trace the payout; preview a settlement only if the bank confirms it.', 'MEDIUM'],
    SETTLEMENT_MISMATCH: ['Settled funds differ from captured funds minus refunds.', settlementGap > 0 ? 'Investigate the shortfall; preview a settlement only if the bank confirms it.' : 'Investigate the excess payout and contact the gateway.', 'MEDIUM'],
  };
  const [reason, nextStep, priority] = details[status];
  return {
    reason,
    nextStep,
    priority,
    impactPaise: status === 'MATCHED' ? 0 : impactPaise,
    capturedGapPaise: capturedGap,
    settlementGapPaise: settlementGap,
    canPreviewSettlement: (status === 'UNSETTLED' || status === 'SETTLEMENT_MISMATCH') && settlementGap > 0 && captured.length === 1,
  };
}

export function reconcile(db) {
  const orders = db.prepare('SELECT * FROM orders ORDER BY id').all();
  const payments = db.prepare('SELECT * FROM payments ORDER BY id').all();
  const refunds = db.prepare('SELECT * FROM refunds ORDER BY id').all();
  const settlements = db.prepare('SELECT * FROM settlements ORDER BY id').all();

  const rows = orders.map(order => {
    const captured = payments.filter(p => p.order_id === order.id && p.status === 'captured');
    const paymentIds = new Set(captured.map(p => p.id));
    const paid = sum(captured, 'amount_paise');
    const refunded = sum(refunds.filter(r => paymentIds.has(r.payment_id)), 'amount_paise');
    const settled = sum(settlements.filter(s => paymentIds.has(s.payment_id)), 'amount_paise');
    const expectedNet = paid - refunded;
    let status = 'MATCHED';
    if (captured.length === 0) status = 'MISSING_PAYMENT';
    else if (captured.length > 1) status = 'DUPLICATE_PAYMENT';
    else if (paid !== order.amount_paise) status = 'AMOUNT_MISMATCH';
    else if (refunded > paid) status = 'REFUND_EXCEEDS_PAYMENT';
    else if (settled === 0 && expectedNet > 0) status = 'UNSETTLED';
    else if (settled !== expectedNet) status = 'SETTLEMENT_MISMATCH';
    return {
      orderId: order.id,
      merchant: order.merchant,
      expectedPaise: order.amount_paise,
      capturedPaise: paid,
      refundedPaise: refunded,
      settledPaise: settled,
      differencePaise: expectedNet - settled,
      paymentIds: captured.map(p => p.id),
      status,
      diagnosis: diagnose(status, { order, captured, paid, refunded, settled, expectedNet }),
    };
  });

  return {
    summary: {
      orders: rows.length,
      matched: rows.filter(row => row.status === 'MATCHED').length,
      exceptions: rows.filter(row => row.status !== 'MATCHED').length,
      capturedPaise: sum(rows, 'capturedPaise'),
      refundedPaise: sum(rows, 'refundedPaise'),
      settledPaise: sum(rows, 'settledPaise'),
      exceptionImpactPaise: rows.reduce((total, row) => total + row.diagnosis.impactPaise, 0),
    },
    rows,
  };
}
