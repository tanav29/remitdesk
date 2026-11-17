import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDesk } from './server.mjs';

const recipient='9xQeWvG816bUx9EPfWoYBqjMbU46JdhQ5eKKkd6oV6x';
const owner='11111111111111111111111111111111';
const invoice={recipient,reference:'DEV-100',vendor:'Pilot studio',amount:'1000',amountBasis:'net'};
async function listen(t, settings) {
  const server=createDesk(settings);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return 'http://127.0.0.1:'+server.address().port;
}
const post = (url,data,headers) => fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(data)});

test('demo quotes exact vendor due, isolates sessions and labels simulated receipts',async t=>{
  const base=await listen(t,{env:{}});
  const state=await fetch(base+'/api/state');
  const headers={cookie:state.headers.get('set-cookie').split(';')[0]};
  const create=await post(base+'/api/invoices',invoice,headers);
  assert.equal(create.status,201);
  const path=base+'/api/invoices/'+(await create.json()).invoice.id;
  assert.equal((await post(base+'/api/invoices',invoice,headers)).status,409);
  const quote=await post(path+'/quote',{},headers);
  assert.deepEqual((await quote.json()).quote,{amount:'1005',net:'1000',fees:'5',solLamports:null,network:'demo'});
  const paid=await post(path+'/simulate',{},headers);
  assert.equal((await paid.json()).invoice.receipt.status,'simulated');
  const other=await fetch(base+'/api/state');
  assert.equal((await other.json()).invoices.some(r=>r.reference===invoice.reference),false);
});

test('partner invoice remains pending until provider confirms settlement and survives reopening', async t=>{
  const dir=mkdtempSync(join(tmpdir(),'remitdesk-test-'));

  const env={MULTIHOPPER_API_KEY:'mh_test_fixture',REMITDESK_OPERATOR_TOKEN:'z'.repeat(40),REMITDESK_DB:join(dir,'private.sqlite')};
  const headers={Authorization:'Bearer '+env.REMITDESK_OPERATOR_TOKEN};
  let status='processing', captured;
  const providerOverride={
    async estimate({amountRaw}) { const gross=BigInt(amountRaw);const net=gross*10000n/10050n;return {tokens:{feeRaw:String(gross-net),netDeliveredRaw:String(net)},sol:{requiredSolUpFrontLamports:24000}}; },
    async create(params) {captured=params;const est=await this.estimate(params);return {...params,id:7,status:'quote',recipientReceivesRaw:est.tokens.netDeliveredRaw,percentFeeRaw:est.tokens.feeRaw};},
    async status() {return {id:7,status,signatures:{hops:['sample-signature']}};},
    async usage() {return {};}
  };
  const settings={env,providerOverride};
  const start=async () => {
    const server=createDesk(settings);
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    return {base:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(resolve=>server.close(resolve))};
  };
  let host=await start();
  try {
    assert.equal((await fetch(host.base+'/api/state')).status,401);
    const result=await post(host.base+'/api/invoices',invoice,headers);
    const id=(await result.json()).invoice.id;
    const path='/api/invoices/'+id;
    assert.equal((await post(host.base+path+'/quote',{},headers)).status,200);
    assert.equal((await post(host.base+path+'/simulate',{},headers)).status,409);
    assert.equal((await post(host.base+path+'/start',{owner},headers)).status,200);
    assert.equal(captured.externalId,id);
    assert.equal((await (await post(host.base+path+'/sync',{},headers)).json()).invoice.status,'pending');
    await host.close();host=await start();
    status='completed';
    const settled=(await (await post(host.base+path+'/sync',{},headers)).json()).invoice;
    assert.equal(settled.status,'paid');
    assert.equal(settled.receipt.netUsdc,'1000');
    assert.equal(settled.receipt.network,'devnet');
    assert.equal(settled.receipt.transferId,7);
  } finally {await host.close();rmSync(dir,{recursive:true,force:true});}
});
