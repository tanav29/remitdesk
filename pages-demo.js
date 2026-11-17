// The Pages build injects this local transport into the app's entry point.
// Each tab has an isolated sample ledger and makes no payment API requests.
const key = 'remitdesk.sampleLedger.v1';
const recipient = '9xQeWvG816bUx9EPfWoYBqjMbU46JdhQ5eKKkd6oV6x';
const now = () => new Date().toISOString();
const respond = (data, status = 200) => new Response(JSON.stringify(data), {status, headers:{'Content-Type':'application/json'}});
function fail(message) { throw new Error(message); }

function units(amount) {
  if (typeof amount !== 'string' || !/^(0|[1-9]\d{0,13})(\.\d{1,6})?$/.test(amount)) fail('Enter a positive USDC amount with up to six decimal places.');
  const [whole, fraction = ''] = amount.split('.');
  const micro = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
  if (micro === 0n || micro > 18446744073709551615n) fail('Enter a positive amount within the USDC limit.');
  return micro;
}

function decimal(micro) {
  const fraction = (micro % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return String(micro / 1000000n) + (fraction ? '.' + fraction : '');
}

function quoteFor(invoice) {
  const target = units(invoice.amount);
  const gross = invoice.amountBasis === 'net' ? (target * 10050n + 9999n) / 10000n : target;
  const net = gross * 10000n / 10050n;
  return {amount:decimal(gross), net:decimal(net), fees:decimal(gross - net), solLamports:null, network:'demo'};
}

function receiptFor(invoice) {
  return {reference:invoice.reference, network:'demo', transferId:'demo-' + invoice.id, status:'simulated', recordedAt:now(), grossUsdc:invoice.quote.amount, netUsdc:invoice.quote.net, recipient:invoice.recipient};
}

function seeds() {
  return [
    ['Orbit Studio','ORB-1042','2400','open'],
    ['Juniper Labs','JUN-0081','850','quoted'],
    ['Northline Creative','NLC-027','3150','open'],
    ['Fieldwork','FW-0318','1200','paid']
  ].map(([vendor,reference,amount,status], index) => {
    const invoice = {id:crypto.randomUUID(), vendor, reference, amount, amountBasis:'gross', recipient, status, createdAt:new Date(Date.now()-index*86400000).toISOString()};
    if (status !== 'open') invoice.quote = quoteFor(invoice);
    if (status === 'paid') invoice.receipt = receiptFor(invoice);
    return invoice;
  });
}

function validAddress(address) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return false;
  let value = 0n;
  for (const ch of address) value = value * 58n + BigInt(alphabet.indexOf(ch));
  const leadingZeros = address.match(/^1*/)[0].length;
  const length = value === 0n ? 0 : Math.ceil(value.toString(16).length / 2);
  return length + leadingZeros === 32;
}

function label(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 100 || /[\u0000-\u001f]/.test(value)) fail('Use a vendor name and invoice reference of 1–100 characters.');
  return value.trim();
}

export async function demoFetch(path, options) {
  try {
    let saved = sessionStorage.getItem(key);
    if (!saved) {
      saved = JSON.stringify(seeds());
      sessionStorage.setItem(key, saved);
    }
    const invoices = JSON.parse(saved);
    const save = () => sessionStorage.setItem(key, JSON.stringify(invoices));
    if (path === '/api/state' && !options.method) return respond({mode:'demo', network:'demo', invoices, integration:{configured:false}});
    if (options.method !== 'POST') return respond({error:'This demonstration supports invoice quotes and simulated receipts.'}, 404);
    if (path === '/api/invoices') {
      const body = JSON.parse(options.body);
      const vendor = label(body.vendor), reference = label(body.reference);
      if (invoices.length >= 100) fail('This demo workspace has reached its invoice limit.');
      if (!validAddress(body.recipient)) fail('Enter a valid Solana wallet address.');
      if (invoices.some(item => item.vendor.toLowerCase() === vendor.toLowerCase() && item.reference.toLowerCase() === reference.toLowerCase())) fail('This vendor already has an invoice with this reference.');
      const invoice = {id:crypto.randomUUID(), vendor, reference, amount:decimal(units(body.amount)), amountBasis:body.amountBasis === 'net' ? 'net':'gross', recipient:body.recipient, status:'open', createdAt:now()};
      invoices.unshift(invoice);
      save();
      return respond({invoice}, 201);
    }
    const match = /^\/api\/invoices\/([a-f0-9-]+)\/(quote|simulate)$/.exec(path);
    const invoice = match && invoices.find(item => item.id === match[1]);
    if (!invoice) return respond({error:'Invoice or action was not found.'}, 404);
    if (match[2] === 'quote') {
      if (invoice.status === 'paid') fail('This invoice already has a payment.');
      invoice.quote = quoteFor(invoice);
      invoice.status = 'quoted';
      save();
      return respond({preview:true, quote:invoice.quote});
    }
    if (!invoice.quote) fail('Preview a quote before simulating a payment.');
    invoice.receipt ??= receiptFor(invoice);
    invoice.status = 'paid';
    save();
    return respond({invoice});
  } catch (error) {
    return respond({error:error.message || 'Could not open the demo ledger in this tab.'}, 400);
  }
}
