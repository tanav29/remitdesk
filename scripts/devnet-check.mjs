import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bs58 from 'bs58';
import { createDesk } from '../server.mjs';

const apiKey = process.env.MULTIHOPPER_API_KEY;
if (!apiKey?.startsWith('mh_test_')) throw new Error('Set a devnet MULTIHOPPER_API_KEY.');
const operator = randomBytes(32).toString('hex');
const dir = await mkdtemp(join(tmpdir(), 'remitdesk-devnet-'));
const desk = createDesk({env:{
  MULTIHOPPER_API_KEY:apiKey, MULTIHOPPER_NETWORK:'devnet', REMITDESK_OPERATOR_TOKEN:operator,
  REMITDESK_DB:join(dir,'test.sqlite')
}});
const publicAddress = () => bs58.encode(generateKeyPairSync('ed25519').publicKey.export({format:'der',type:'spki'}).subarray(-32));
try {
  await new Promise(resolve=>desk.listen(0,'127.0.0.1',resolve));
  const base = 'http://127.0.0.1:'+desk.address().port;
  async function post(path, body) {
    const response = await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+operator},body:JSON.stringify(body)});
    const result = await response.json();
    if (!response.ok) throw new Error(path.split('/').at(-1)+' failed: '+result.error);
    return result;
  }
  const owner=publicAddress();
  const {invoice}=await post('/api/invoices',{vendor:'Devnet verification',reference:'DEV-001',amount:'1',amountBasis:'net',recipient:publicAddress()});
  const prefix='/api/invoices/'+invoice.id+'/';
  const {quote}=await post(prefix+'quote',{});
  const {invoice:locked}=await post(prefix+'start',{owner});
  const next=await post(prefix+'advance',{owner});
  if (next.stage!=='sign' || next.group!=='keeperFundingSignature' || !next.unsigned) throw new Error('Expected the unsigned keeper funding transaction.');
  const {invoice:tracked}=await post(prefix+'sync',{});
  console.log(JSON.stringify({environment:'devnet',transferId:locked.transferId,quote,providerStatus:tracked.providerStatus,firstUnsignedTransaction:next.group,broadcast:false},null,2));
} finally {
  await new Promise(resolve=>desk.close(resolve));
  await rm(dir, {recursive:true,force:true});
}
