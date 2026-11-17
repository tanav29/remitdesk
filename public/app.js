import { renderWallet } from './wallet.js';

const get = id => document.getElementById(id);
const labels = { open: 'Open', quoted: 'Quoted', pending: 'In progress', paid: 'Paid', failed: 'Failed' };
let state;
let selected;
let operatorToken = '';
let filter = 'all';
let loadingSequence = 0;
let busy = false;
let transport;

function el(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}

function units(amount) {
  const [whole, fraction = ''] = String(amount).split('.');
  return BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
}

function displayUnits(value) {
  const fraction = (value % 1000000n).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return (value / 1000000n).toLocaleString('en-US') + '.' + fraction;
}

const money = value => displayUnits(units(value));
const route = (invoice, action) => '/api/invoices/' + encodeURIComponent(invoice.id) + '/' + action;

function notice(message, retry) {
  const box = get('notice');
  box.replaceChildren();
  box.hidden = !message;
  box.classList.toggle('error-notice', Boolean(retry));
  if (message) box.append(el('span', '', message));
  if (typeof retry === 'function') box.append(button('Retry', '', retry));
}

function button(label, className, fn) {
  const node = el('button', className, label);
  node.type = 'button';
  node.addEventListener('click', fn);
  return node;
}

function lockDesk() {
  operatorToken = '';
  state = undefined;
  selected = undefined;
  get('workspace').hidden = true;
  get('register').replaceChildren();
  get('invoice-detail').replaceChildren();
  get('locked').hidden = false;
  get('logout').hidden = true;
  get('new-invoice').disabled = true;
  get('environment').textContent = 'Private workspace';
  if (get('invoice-dialog').open) get('invoice-dialog').close();
  notice('');
}

async function api(path, body) {
  const headers = { Accept: 'application/json' };
  if (operatorToken) headers.Authorization = 'Bearer ' + operatorToken;
  const options = { headers, cache: 'no-store' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    options.method = 'POST';
    options.body = JSON.stringify(body);
  }
  const result = await transport(path, options);
  const data = await result.json().catch(() => ({}));
  if (!result.ok) {
    if (result.status === 401 && state?.mode === 'demo') notice('Your demo session expired. Reload to open a fresh workspace.', openDesk);
    else if (result.status === 401 || result.status === 403 && !state) lockDesk();
    throw Object.assign(new Error(typeof data.error === 'string' ? data.error : 'Request failed (' + result.status + ').'), {status: result.status});
  }
  return data;
}

async function refresh() {
  const sequence = ++loadingSequence;
  const next = await api('/api/state');
  if (sequence !== loadingSequence) return;
  state = next;
  if (!state.invoices.some(invoice => invoice.id === selected)) selected = state.invoices[0]?.id;
  get('workspace').hidden = false;
  get('pilot-link').hidden = state.mode !== 'demo';
  get('locked').hidden = true;
  get('logout').hidden = !operatorToken;
  get('new-invoice').disabled = false;
  get('environment').textContent = state.mode === 'demo' ? 'Demo workspace' : 'Partner · ' + state.network;
  render();
}

async function openDesk() {
  notice('');
  get('loading').hidden = false;
  try { await refresh(); }
  catch (error) { if (error.status !== 401) notice(error.message, openDesk); }
  finally { get('loading').hidden = true; }
}

function badge(status) {
  const defined = Object.hasOwn(labels, status);
  return el('span', 'status' + (defined ? ' status-' + status : ''), defined ? labels[status] : String(status));
}

function filteredInvoices() {
  const term = get('search').value.trim().toLowerCase();
  return state.invoices.filter(item => {
    const eligible = filter === 'all' || (filter === 'paid' ? item.status === 'paid' : item.status !== 'paid');
    return eligible && (item.vendor + ' ' + item.reference).toLowerCase().includes(term);
  });
}

function render() {
  const unpaid = state.invoices.filter(invoice => invoice.status !== 'paid');
  get('outstanding').textContent = displayUnits(unpaid.reduce((sum, invoice) => sum + units(invoice.amount), 0n));
  get('outstanding-count').textContent = String(unpaid.length);
  get('paid-count').textContent = String(state.invoices.length - unpaid.length);
  get('outstanding-count').nextElementSibling.textContent = unpaid.length === 1 ? 'invoice' : 'invoices';
  get('paid-count').nextElementSibling.textContent = state.invoices.length - unpaid.length === 1 ? 'invoice' : 'invoices';
  get('total-count').textContent = String(state.invoices.length);
  renderRegister();
  renderDetails();
}

function renderRegister() {
  const root = get('register');
  root.replaceChildren();
  const invoices = filteredInvoices();
  if (!invoices.length) {
    const empty = el('div','empty');
    empty.append(el('h3', '', state.invoices.length ? 'No matching invoices' : 'Your register is ready'));
    empty.append(el('p', '', state.invoices.length ? 'Try another vendor, reference or status.' : 'Add a vendor invoice to preview its payment route.'));
    if (!state.invoices.length) empty.append(button('Create first invoice','button secondary', showForm));
    root.append(empty);
    return;
  }
  const table = el('table');
  const headers = table.createTHead().insertRow();
  for (const [name, cls] of [['Vendor / reference','col-vendor'], ['Invoice USDC','col-amount'], ['Status','col-status']]) {
    const th = el('th', cls, name);
    th.scope = 'col';
    headers.append(th);
  }
  const tbody = table.createTBody();
  for (const invoice of invoices) {
    const row = tbody.insertRow();
    const isSelected = invoice.id === selected;
    row.classList.toggle('row-focused', isSelected);
    const select = button('', 'vendor-button', () => {
      if (busy) return;
      selected = invoice.id;
      for (const other of tbody.rows) {
        const current = other === row;
        other.classList.toggle('row-focused', current);
        other.querySelector('button').setAttribute('aria-pressed', String(current));
      }
      renderDetails();
      if (matchMedia('(max-width:730px)').matches) get('detail-title').scrollIntoView({block:'start'});
    });
    select.setAttribute('aria-label', 'Open ' + invoice.vendor + ', ' + invoice.reference);
    select.setAttribute('aria-pressed', String(isSelected));
    const initials = invoice.vendor.trim().split(/\s+/).slice(0, 2).map(word => Array.from(word)[0]).join('').toUpperCase();
    const tone = Array.from(invoice.vendor).reduce((sum, ch) => sum + ch.codePointAt(0), 0) % 4;
    const avatar = el('span', 'avatar tone-' + tone, initials);
    avatar.setAttribute('aria-hidden', 'true');
    const name = el('span', 'vendor-identity');
    name.append(el('span', 'vendor-name', invoice.vendor), el('span', 'ref', invoice.reference));
    select.append(avatar, name);
    row.insertCell().append(select);
    row.insertCell().append(el('span','amount-cell', money(invoice.amount)));
    row.insertCell().append(badge(invoice.status));
  }
  root.append(table);
}

function fact(list, label, value) {
  const row = el('div','fact');
  row.append(el('dt','',label),el('dd','',value));
  list.append(row);
}

function invoiceAction(invoice, action) {
  return async event => {
    if (busy) return;
    busy = true;
    const control = event.currentTarget;
    control.disabled = true;
    const previous = control.textContent;
    control.textContent = action === 'quote' ? 'Getting quote…' : 'Recording demo payment…';
    const error = get('detail-error');
    error.textContent = '';
    try {
      await api(route(invoice, action), {});
      await refresh();
      notice(action === 'quote' ? 'Quote ready for ' + invoice.reference + '.' : 'Demo receipt recorded for ' + invoice.reference + '.');
    } catch (failure) { error.textContent = failure.message; }
    finally { busy = false; control.disabled = false; control.textContent = previous; }
  };
}

function downloadReceipt(invoice) {
  const payload = {mode:state.mode, invoiceId:invoice.id, vendor:invoice.vendor, invoiceReference:invoice.reference, enteredUSDC:invoice.amount, amountBasis:invoice.amountBasis || 'gross', grossUSDC:invoice.quote?.amount, recipient:invoice.recipient, quote:invoice.quote, receipt:invoice.receipt};
  const blob = new Blob([JSON.stringify(payload, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const link = el('a');
  link.href = url;
  link.download = 'remitdesk-' + (state.mode === 'demo' ? 'demo-' : '') + invoice.reference.replace(/[^a-zA-Z0-9.-]/g, '_').slice(0, 80) + '.json';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderDetails() {
  const invoice = state.invoices.find(item => item.id === selected);
  const root = get('invoice-detail');
  root.replaceChildren();
  if (!invoice) {
    const empty = el('div', 'empty');
    empty.append(el('h3', '', 'Select an invoice'), el('p', '', 'Its destination, fees and receipt will appear here.'));
    root.append(empty);
    return;
  }
  const title = el('div','detail-vendor');
  title.append(el('h3','',invoice.vendor), badge(invoice.status));
  root.append(title, el('p','detail-ref',invoice.reference));
  const facts = el('dl');
  fact(facts, invoice.amountBasis === 'net' ? 'Vendor due' : 'Gross payment', money(invoice.amount) + ' USDC');
  const date = new Date(invoice.createdAt);
  if (Number.isFinite(date.valueOf())) fact(facts, 'Created', date.toLocaleDateString(undefined, {month:'short',day:'numeric',year:'numeric'}));
  const wallet = el('div', 'wallet-address');
  wallet.append(el('small', '', 'Recipient wallet'), el('code','',invoice.recipient));
  root.append(facts, wallet);
  if (invoice.quote) {
    const quote = invoice.quote;
    const section = el('section','quote');
    const amounts = el('dl');
    if (quote.amount != null) fact(amounts, 'Gross routed', money(quote.amount) + ' USDC');
    if (quote.fees != null) fact(amounts, 'Token fees', money(quote.fees) + ' USDC');
    if (quote.net != null) fact(amounts, 'Vendor receives', money(quote.net) + ' USDC');
    if (quote.solLamports != null) fact(amounts, 'SOL required up front (lamports)', String(quote.solLamports));
    if (quote.network) fact(amounts, 'Network', quote.network);
    section.append(el('h3', 'subhead', state.mode === 'demo' ? 'Demo route quote' : 'MultiHopper quote'), amounts);
    root.append(section);
  }
  const actions = el('div','detail-actions');
  if (invoice.receipt) {
    actions.append(button('Download ' + (state.mode === 'demo' ? 'demo ' : '') + 'receipt', 'button secondary', () => downloadReceipt(invoice)));
  } else if (!invoice.paymentStarted && ['open','quoted'].includes(invoice.status)) {
    if (!invoice.quote || state.mode === 'partner') actions.append(button(invoice.quote ? 'Refresh route quote' : 'Preview route quote', 'button ' + (invoice.quote ? 'secondary' : 'primary'), invoiceAction(invoice,'quote')));
    if (state.mode === 'demo' && invoice.quote) actions.append(button('Simulate payment', 'button primary', invoiceAction(invoice,'simulate')));
    if (state.mode === 'demo') actions.append(el('p','hint','Demo payments use sample data. No funds move.'));
  }
  const error = el('p','error');
  error.id = 'detail-error';
  error.setAttribute('role', 'alert');
  const walletActions = el('div','detail-actions');
  walletActions.id = 'wallet-actions';
  root.append(actions, walletActions, error);
  renderWallet({el:walletActions, invoice, mode:state.mode, api, refresh});
}

function showForm() {
  get('invoice-form').reset();
  describeBasis();
  get('form-error').textContent = '';
  get('amount').setCustomValidity('');
  get('invoice-dialog').showModal();
  get('vendor').focus();
}

get('access-form').addEventListener('submit', async event => {
  event.preventDefault();
  const control = event.submitter;
  control.disabled = true;
  get('access-error').textContent = '';
  operatorToken = get('operator-token').value.trim();
  try { await refresh(); get('operator-token').value = ''; }
  catch (error) { get('access-error').textContent = error.status === 401 ? 'The token was rejected. Check the value and try again.' : error.message; }
  finally { control.disabled = false; }
});
get('logout').addEventListener('click', () => { ++loadingSequence; lockDesk(); get('operator-token').focus(); });
get('new-invoice').addEventListener('click', showForm);
for (const id of ['close-dialog', 'cancel-invoice']) get(id).addEventListener('click', () => get('invoice-dialog').close());
get('amount').addEventListener('input', () => get('amount').setCustomValidity(''));
function describeBasis() {
  get('basis-description').textContent = get('exact-amount').checked ? 'The quote adds route fees to the amount you pay.' : 'Route fees come out of the entered amount.';
}
get('exact-amount').addEventListener('change', describeBasis);
get('invoice-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const amount = get('amount');
  if (units(amount.value) <= 0n) {
    amount.setCustomValidity('Enter an amount above zero.');
    amount.reportValidity();
    return;
  }
  get('save-invoice').disabled = true;
  get('form-error').textContent = '';
  try {
    const body = Object.fromEntries(Array.from(new FormData(form), ([key, value]) => [key, value.trim()]));
    body.amountBasis = get('exact-amount').checked ? 'net' : 'gross';
    const result = await api('/api/invoices', body);
    selected = result.invoice?.id ?? result.id;
    filter = 'all';
    syncFilters();
    get('search').value = '';
    get('invoice-dialog').close();
    await refresh();
    notice('Invoice ' + body.reference + ' created.');
  } catch (error) {
    if (get('invoice-dialog').open) get('form-error').textContent = error.message;
    else notice(error.message, openDesk);
  } finally { get('save-invoice').disabled = false; }
});
function syncFilters() {
  for (const item of document.querySelectorAll('[data-filter]')) item.setAttribute('aria-pressed', String(item.dataset.filter === filter));
}
function applyFilter() {
  if (!state) return;
  const invoices = filteredInvoices();
  if (!invoices.some(item => item.id === selected)) selected = invoices[0]?.id;
  renderRegister();
  renderDetails();
}
for (const item of document.querySelectorAll('[data-filter]')) item.addEventListener('click', () => {
  filter = item.dataset.filter;
  syncFilters();
  applyFilter();
});
get('search').addEventListener('input', applyFilter);
export function startDesk(fetcher) {
  transport = fetcher;
  return openDesk();
}
