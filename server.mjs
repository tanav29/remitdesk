import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMultiHopper, formatUsdc, parseUsdc, isSolanaAddress } from './adapter.mjs';
import { exactQuote } from './quote.mjs';
import { advance, makeRpc } from './payments.mjs';

const now = () => new Date().toISOString();
const root = dirname(fileURLToPath(import.meta.url));
const fail = (status, message) => { throw Object.assign(new Error(message), {httpStatus:status}); };
const hash = s => createHash('sha256').update(s).digest();
function label(s, name) {
  if (typeof s !== 'string' || !s.trim() || s.trim().length > 100 || /[\u0000-\u001f]/.test(s)) fail(400, 'Enter a valid ' + name + ' (1â€“100 characters).');
  return s.trim();
}
function demoQuote(entered, basis) {
  const target = BigInt(parseUsdc(entered));
  const raw = basis === "net" ? (target * 10050n + 9999n) / 10000n : target;
  const amount = formatUsdc(raw.toString());
  const net = raw * 10000n / 10050n;
  return {amount, net: formatUsdc(net.toString()), fees:formatUsdc((raw-net).toString()), solLamports:null, network:'demo'};
}
function samples() {
  const names = [['Orbit Studio','ORB-1042','2400','open'],['Juniper Labs','JUN-0081','850','quoted'],['Northline Creative','NLC-027','3150','open'],['Fieldwork','FW-0318','1200','paid']];
  return names.map(([vendor,reference,amount,status],i) => {
    const id = randomUUID();
    const createdAt = new Date(Date.now()-i*86400000).toISOString();
    const row = {id,vendor,reference,amount,status,createdAt,recipient:'9xQeWvG816bUx9EPfWoYBqjMbU46JdhQ5eKKkd6oV6x'};
    if (status !== 'open') row.quote = demoQuote(amount);
    if (status === 'paid') row.receipt = demoReceipt(row);
    return row;
  });
}
const demoReceipt = r => ({reference:r.reference, network:'demo',transferId:'demo-'+r.id,status:'simulated',recordedAt:now(),grossUsdc:r.quote.amount,netUsdc:r.quote.net,recipient:r.recipient});
const expose = ({payment, ...r}) => ({...r,paymentStarted:!!payment,transferId:payment?.transferId,sourceOwner:payment?.owner,providerStatus:payment?.providerStatus,submitted:!!payment?.submitted});
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) fail(415, 'Use application/json.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    if ((size += chunk.length) > 16000) fail(413,'Request is too large.');
    chunks.push(chunk);
  }
  try { const data=JSON.parse(Buffer.concat(chunks)); if (data && typeof data==='object' && !Array.isArray(data)) return data; } catch {}
  fail(400,'Expected a JSON object.');
}
export function createDesk({env = process.env, providerOverride, rpcOverride} = {}) {
  const partner = !!env.MULTIHOPPER_API_KEY || env.REMITDESK_MODE === 'partner';
  const network = env.MULTIHOPPER_NETWORK || 'devnet';
  const operator = env.REMITDESK_OPERATOR_TOKEN || '';
  if (partner && (!env.MULTIHOPPER_API_KEY || operator.length < 32 || !['devnet','mainnet'].includes(network))) throw new Error('Partner mode requires an environment-specific key, valid network, and a 32-character or longer operator token.');
  const provider = partner && (providerOverride || createMultiHopper({apiKey:env.MULTIHOPPER_API_KEY, network}));
  const rpc = partner && (rpcOverride || makeRpc(env.SOLANA_RPC_URL || (network === 'mainnet' ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com'),network));
  const sessions = new Map();
  const locks = new Set();
  let db;
  if (partner) {
    const filename = resolve(env.REMITDESK_DB || ('data/'+network+'.sqlite'));
    mkdirSync(dirname(filename), {recursive:true});
    db = new DatabaseSync(filename);
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, vendor TEXT COLLATE NOCASE, reference TEXT COLLATE NOCASE, payload TEXT NOT NULL, UNIQUE(vendor,reference)); CREATE TABLE IF NOT EXISTS settings (network TEXT NOT NULL)');
    if (!db.prepare('SELECT network FROM settings').get()) db.prepare('INSERT INTO settings VALUES (?)').run(network);
    if (db.prepare('SELECT network FROM settings').get().network !== network) throw new Error('Choose a separate database for this network.');
  }
  const server = createServer(async (req,res) => {
    const json = (data,status=200) => { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data)); };
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (!path.startsWith('/api/')) {
        if (req.method !== 'GET' || !/^\/(?:index\.html|styles\.css|app\.js|site\.js|wallet\.js|[A-Za-z0-9_.-]+\.(?:woff2|svg|ico))?$/.test(path)) fail(404,'Page not found.');
        const name = path === '/' ? '/index.html' : path;
        let file;
        try { file=readFileSync(root+'/public'+name); } catch {fail(404,'File not found.');}
        res.setHeader('Content-Type',({'html':'text/html; charset=utf-8','css':'text/css','js':'text/javascript','woff2':'font/woff2','svg':'image/svg+xml','ico':'image/x-icon'})[name.split('.').at(-1)]);
        return res.end(file);
      }
      if (partner && !timingSafeEqual(hash(req.headers.authorization || ''), hash('Bearer '+operator))) fail(401,'Enter the operator token to open this desk.');
      let rows;
      if (!partner) {
        const sid = /(?:^|; )desk=([a-f0-9-]{36})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
        rows = sessions.get(sid);
        if (!rows) {
          if (path !== '/api/state') fail(401,'Reload the demo to start a new workspace.');
          if (sessions.size >= 500) sessions.delete(sessions.keys().next().value);
          const id=randomUUID(); rows=samples(); sessions.set(id,rows);
          res.setHeader('Set-Cookie','desk='+id+'; HttpOnly; SameSite=Strict; Path=/');
        }
      }
      const save = r => { if (db) db.prepare('UPDATE invoices SET payload=? WHERE id=?').run(JSON.stringify(r),r.id); };
      const all = () => rows || db.prepare('SELECT payload FROM invoices ORDER BY rowid DESC').all().map(({payload})=>JSON.parse(payload));
      if (req.method === 'GET' && path === '/api/state') return json({mode:partner?'partner':'demo',network:partner?network:'demo',invoices:all().map(expose),integration:{configured:partner}});
      if (req.method === 'GET' && path === '/api/evidence') {
        const receipts = all().filter(r=>r.receipt).map(r=>r.receipt);
        return json({environment:partner?network:'demo',generatedAt:now(),receipts,usage:partner?await provider.usage():null});
      }
      if (req.method !== 'POST') fail(404,'Unknown endpoint.');
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) fail(403,'Cross-origin action refused.');
      const data = await body(req);
      if (path === '/api/invoices') {
        const vendor=label(data.vendor,'vendor'), reference=label(data.reference,'reference');
        if (!isSolanaAddress(data.recipient)) fail(400,'Enter a valid Solana wallet address.');
        let amount;
        try { amount=formatUsdc(parseUsdc(data.amount)); } catch { fail(400,'Enter a positive USDC amount with up to six decimal places.'); }
        const existing=all();
        if (existing.some(r=>r.vendor.toLowerCase()===vendor.toLowerCase() && r.reference.toLowerCase()===reference.toLowerCase())) fail(409,'This vendor already has an invoice with this reference.');
        if (rows?.length>=100) fail(400,'This demo workspace has reached its invoice limit.');
        const r={id:randomUUID(),vendor,reference,amount,amountBasis:data.amountBasis === "net" ? "net" : "gross",recipient:data.recipient,status:'open',createdAt:now()};
        if (rows) rows.unshift(r);
        else db.prepare('INSERT INTO invoices VALUES (?,?,?,?)').run(r.id,vendor,reference,JSON.stringify(r));
        return json({invoice:expose(r)},201);
      }
      const match = /^\/api\/invoices\/([a-f0-9-]{36})\/(quote|simulate|start|advance|sync)$/.exec(path);
      if (!match) fail(404,'Unknown action.');
      const [,id,action]=match;
      if (locks.has(id)) fail(409,'This invoice is being updated. Refresh and retry.');
      locks.add(id);
      try {
        const r=all().find(row=>row.id===id);
        if (!r) fail(404,'Invoice not found.');
        if (action==='quote') {
          if (r.payment || r.status==='paid') fail(409,'This invoice already has a payment.');
          r.quote=partner ? await exactQuote(r, async amountRaw => {
            const estimate=await provider.estimate({amountRaw});
            return {amount:formatUsdc(amountRaw),net:formatUsdc(estimate.tokens.netDeliveredRaw),fees:formatUsdc(estimate.tokens.feeRaw),solLamports:String(estimate.sol.requiredSolUpFrontLamports),network};
          }) : demoQuote(r.amount,r.amountBasis);
          r.status='quoted'; save(r);
          return json({quote:r.quote,preview:!partner});
        }
        if (action==='simulate') {
          if (partner || !['quoted','paid'].includes(r.status)) fail(409,'Quote a demo invoice first.');
          r.receipt ??= demoReceipt(r); r.status='paid'; return json({invoice:expose(r)});
        }
        if (!partner) fail(403,'This action requires a partner environment.');
        if (action==='start') {
          if (!r.quote || r.status==='paid' || !isSolanaAddress(data.owner) || data.owner===r.recipient) fail(400,'Quote the invoice and connect a distinct payer wallet.');
          if (r.payment?.owner && r.payment.owner!==data.owner) fail(409,'Reconnect the original payer.');
          r.payment ??= {owner:data.owner, signatures:{routeInitSignatures:[]}};
          save(r);
          if (!r.payment.transferId) {
            const t=await provider.create({amountRaw:parseUsdc(r.quote.amount),sourceOwner:data.owner,recipientWallet:r.recipient,externalId:r.externalId || r.id});
            if (!Number.isSafeInteger(t.id) || t.recipientWallet!==r.recipient || String(t.amountRaw)!==String(parseUsdc(r.quote.amount)) || t.sourceOwner!==data.owner) fail(502,'Provider returned a different transfer.');
            if (r.amountBasis==='net' && BigInt(t.recipientReceivesRaw)!==BigInt(parseUsdc(r.amount))) {
              delete r.payment; delete r.quote; r.externalId=randomUUID(); r.status='open'; save(r);
              fail(409,'Pricing changed before the route was locked. Refresh and quote this invoice again.');
            }
            r.payment.transferId=t.id; r.payment.providerStatus=t.status;
            r.quote.net=formatUsdc(t.recipientReceivesRaw);
            r.quote.fees=formatUsdc(t.percentFeeRaw);
            r.status='pending';save(r);
          }
          return json({invoice:expose(r)});
        }
        if (!r.payment?.transferId) fail(409,'Create a transfer first.');
        if (action==='sync') {
          const t=await provider.status(r.payment.transferId);
          if (t.id!==r.payment.transferId) fail(502,'Provider transfer identifier mismatch.');
          r.payment.providerStatus=t.status;
          if (['active','processing','completed','expired','failed','refunded'].includes(t.status)) r.payment.submitted=true;
          r.status=t.status==='completed'?'paid':(['expired','failed','refunded'].includes(t.status)?'failed':'pending');
          if (r.status==='paid') r.receipt={reference:r.reference,network,transferId:t.id,status:t.status,recordedAt:r.receipt?.recordedAt || now(),completedAt:t.completedAt || null,grossUsdc:r.quote.amount,netUsdc:r.quote.net,recipient:r.recipient,externalId:r.externalId || r.id,signatures:t.signatures,route:t.route};
          else delete r.receipt;
          save(r);return json({invoice:expose(r)});
        }
        if (data.owner!==r.payment.owner) fail(409,'Reconnect the original payer.');
        return json(await advance(r,{provider,rpc,save:()=>save(r)},data));
      } finally {locks.delete(id);}
    } catch (err) {
      const status=err.httpStatus || 502;
      json({error:err.message?.replace(/mh_(?:live|test)_[\w-]+/g,'[redacted]') || 'Request failed.'}, status);
    }
  });
  server.on('close',()=>db?.close());
  return server;
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const host=process.env.HOST || '127.0.0.1', port=Number(process.env.PORT || 4173);
  createDesk().listen(port,host,()=>console.log('RemitDesk listening on '+host+':'+port));
}
