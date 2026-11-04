const money = paise => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(paise / 100);
const labels = {
  MATCHED: 'Matched',
  UNSETTLED: 'Unsettled',
  AMOUNT_MISMATCH: 'Amount mismatch',
  DUPLICATE_PAYMENT: 'Duplicate payment',
  SETTLEMENT_MISMATCH: 'Settlement mismatch',
  MISSING_PAYMENT: 'Missing payment',
  REFUND_EXCEEDS_PAYMENT: 'Refund exceeds payment',
};
let dashboard = { summary: {}, rows: [] };
let selectedOrderId = null;
let settlementPreview = null;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function render() {
  const { summary, rows } = dashboard;
  document.getElementById('orders').textContent = summary.orders;
  document.getElementById('matched').textContent = summary.matched;
  document.getElementById('exceptions').textContent = summary.exceptions;
  document.getElementById('settled').textContent = money(summary.settledPaise);
  const rate = summary.orders ? Math.round(summary.matched / summary.orders * 100) : 0;
  document.getElementById('match-rate').textContent = rate + '% of orders reconciled';
  document.getElementById('coverage-value').textContent = rate + '%';
  document.getElementById('coverage-bar').style.width = rate + '%';

  const query = document.getElementById('search').value.trim().toLowerCase();
  const filter = document.getElementById('status-filter').value;
  const visible = rows.filter(row => {
    const textMatches = row.orderId.toLowerCase().includes(query) || row.merchant.toLowerCase().includes(query);
    const statusMatches = filter === 'ALL' || (filter === 'EXCEPTIONS' && row.status !== 'MATCHED') || row.status === filter;
    return textMatches && statusMatches;
  });
  document.getElementById('rows').innerHTML = visible.map(row => (
    '<tr><td><strong>' + escapeHtml(row.orderId) + '</strong><span>' + escapeHtml(row.merchant) + '</span></td>' +
    '<td>' + money(row.expectedPaise) + '</td>' +
    '<td>' + money(row.capturedPaise) + '</td>' +
    '<td>' + money(row.refundedPaise) + '</td>' +
    '<td>' + money(row.settledPaise) + '</td>' +
    '<td><span class="status ' + (row.status === 'MATCHED' ? 'good' : 'bad') + '">' + escapeHtml(labels[row.status] || row.status) + '</span></td>' +
    '<td><button class="review-button" type="button" data-order="' + escapeHtml(row.orderId) + '" aria-label="Review ' + escapeHtml(row.orderId) + '">Review</button></td></tr>'
  )).join('');
  document.getElementById('empty').hidden = visible.length !== 0;
  renderInvestigation();
}

function renderInvestigation() {
  const panel = document.getElementById('investigation');
  const row = dashboard.rows.find(item => item.orderId === selectedOrderId);
  panel.hidden = !row;
  if (!row) return;
  document.getElementById('investigation-title').textContent = row.merchant + ' · ' + row.orderId;
  document.getElementById('priority').textContent = row.diagnosis.priority === 'NONE' ? 'MATCHED' : row.diagnosis.priority + ' PRIORITY';
  document.getElementById('priority').className = 'priority ' + row.diagnosis.priority.toLowerCase();
  document.getElementById('reason').textContent = row.diagnosis.reason;
  document.getElementById('next-step').textContent = row.diagnosis.nextStep;
  document.getElementById('impact').textContent = money(row.diagnosis.impactPaise);
  document.getElementById('preview-controls').hidden = !row.diagnosis.canPreviewSettlement;
  document.getElementById('preview-result').hidden = !settlementPreview || settlementPreview.orderId !== row.orderId;
  if (settlementPreview && settlementPreview.orderId === row.orderId) {
    document.getElementById('preview-copy').textContent = `Adding a ${money(settlementPreview.amountPaise)} settlement changes this order from ${labels[settlementPreview.before.status]} to ${labels[settlementPreview.after.status]}. Open exceptions: ${settlementPreview.before.exceptions} → ${settlementPreview.after.exceptions}.`;
  }
  document.getElementById('investigation-error').hidden = true;
}

async function demoRequest(path, orderId) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orderId }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Action failed');
  return result;
}

function showInvestigationError(error) {
  const element = document.getElementById('investigation-error');
  element.textContent = error.message;
  element.hidden = false;
}

async function load() {
  const response = await fetch('/api/dashboard');
  if (!response.ok) throw new Error('Dashboard could not load');
  dashboard = await response.json();
  render();
}

async function action(path, button) {
  button.disabled = true;
  try {
    const response = await fetch(path, { method: 'POST' });
    if (!response.ok) throw new Error('Action failed');
    dashboard = await response.json();
    settlementPreview = null;
    render();
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
  }
}

document.getElementById('search').addEventListener('input', render);
document.getElementById('status-filter').addEventListener('change', render);
document.getElementById('resolve').addEventListener('click', event => action('/api/demo/resolve-late-payout', event.currentTarget));
document.getElementById('reset').addEventListener('click', event => action('/api/demo/reset', event.currentTarget));
document.getElementById('rows').addEventListener('click', event => {
  const button = event.target.closest('button[data-order]');
  if (!button) return;
  selectedOrderId = button.dataset.order;
  settlementPreview = null;
  renderInvestigation();
  document.getElementById('investigation').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});
document.getElementById('preview-button').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    settlementPreview = await demoRequest('/api/demo/preview-settlement', selectedOrderId);
    renderInvestigation();
  } catch (error) { showInvestigationError(error); }
  finally { button.disabled = false; }
});
document.getElementById('apply-button').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    dashboard = await demoRequest('/api/demo/apply-settlement', selectedOrderId);
    settlementPreview = null;
    render();
  } catch (error) { showInvestigationError(error); }
  finally { button.disabled = false; }
});
load().catch(error => {
  document.getElementById('rows').innerHTML = '<tr><td colspan="7">' + escapeHtml(error.message) + '</td></tr>';
});
