import { getTransactionDecoder } from '@solana/transactions';
import bs58 from 'bs58';
import { createPublicKey, verify } from 'node:crypto';

function requireValue(ok, message) {
  if (!ok) throw Object.assign(new Error(message), { httpStatus: 409 });
}

export function bundleSteps(bundle) {
  requireValue(bundle && Number.isSafeInteger(bundle.lastValidBlockHeight) &&
    (bundle.routeInitTxs === null || Array.isArray(bundle.routeInitTxs)) &&
    (bundle.sessionInitTxs === null || Array.isArray(bundle.sessionInitTxs)),
    'Incomplete provider bundle. Request a fresh bundle.');
  requireValue(!bundle.dispersionInitTxs?.length, 'Unexpected multi-recipient bundle.');
  return [
    ['keeperFundingSignature', bundle.keeperFundingTx],
    ...(bundle.routeInitTxs || []).map(tx => ['routeInitSignatures', tx.base64]),
    ['orchestratorInitSignature', bundle.orchestratorInitTx],
    ...(bundle.sessionInitTxs || []).map(tx => ['sessionInitSignatures', tx])
  ].filter(([, bytes]) => bytes != null).map(([group, bytes]) => ({group, bytes}));
}

export function inspectSigned(unsigned, signed, owner) {
  const expected = getTransactionDecoder().decode(Buffer.from(unsigned, 'base64'));
  const actual = getTransactionDecoder().decode(Buffer.from(signed, 'base64'));
  const message = Buffer.from(expected.messageBytes);
  const [payer] = Object.keys(actual.signatures);
  requireValue(payer === owner && actual.signatures[owner] && message.equals(Buffer.from(actual.messageBytes)),
    'Wallet signed a different payment.');
  const key = createPublicKey({ key: Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(bs58.decode(payer))
  ]), format: 'der', type: 'spki' });
  requireValue(verify(null, message, key, actual.signatures[owner]), 'Invalid payer signature.');
  for (const [address, signature] of Object.entries(expected.signatures)) {
    if (address === owner) continue;
    requireValue(signature && actual.signatures[address] &&
      Buffer.from(signature).equals(Buffer.from(actual.signatures[address])), 'Wallet changed a provider co-signature.');
  }
  return bs58.encode(actual.signatures[owner]);
}

export function makeRpc(url, network) {
  const genesis = network === 'mainnet' ? '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' : 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
  async function call(method, params = []) {
    const response = await fetch(url, {method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({jsonrpc:'2.0',id:1,method,params}), signal: AbortSignal.timeout(12000)});
    const result = await response.json();
    if (!response.ok || result.error) throw new Error('Solana RPC could not complete ' + method + '. Retry or inspect the transfer in the partner dashboard.');
    return result.result;
  }
  return {
    async checkNetwork() { requireValue(await call('getGenesisHash') === genesis, 'RPC network does not match the transfer environment.'); },
    async finalizedHeight() { return call('getBlockHeight', [{commitment:'finalized'}]); },
    async status(signature) { return (await call('getSignatureStatuses', [[signature], {searchTransactionHistory:true}])).value[0]; },
    async send(bytes) { return call('sendTransaction', [bytes, {encoding:'base64',preflightCommitment:'confirmed',maxRetries:3}]); }
  };
}

// Commit the exact signed bytes before any broadcast. Replays then have the same signature.
export async function advance(invoice, {provider, rpc, save}, input = {}) {
  const p = invoice.payment;
  requireValue(p?.transferId && !p.submitted, 'Refresh the transfer status before continuing.');
  await rpc.checkNetwork();
  if (!p.steps) {
    const {preparedTxs} = await provider.prepare(p.transferId);
    p.steps = bundleSteps(preparedTxs);
    p.lastValidBlockHeight = preparedTxs.lastValidBlockHeight;
    save();
  }
  const step = p.steps[0];
  if (!step) {
    const {transfer} = await provider.confirm(p.transferId, p.signatures);
    if (['quote','awaiting_signature'].includes(transfer.status)) {
      delete p.steps;
      save();
      throw new Error('MultiHopper still sees incomplete route setup. Resume to reconcile on-chain progress.');
    }
    p.submitted = true;
    save();
    return {stage:'submitted'};
  }
  if (input.signed && !step.signature) {
    step.signature = inspectSigned(step.bytes, input.signed, p.owner);
    step.signed = input.signed;
    save();
  }
  const chain = step.signature ? await rpc.status(step.signature) : null;
  if (chain?.err) {
    delete p.steps;
    save();
    throw new Error('Solana reported a failed transaction. Resume to obtain a reconciled bundle.');
  }
  if (['confirmed','finalized'].includes(chain?.confirmationStatus)) {
    if (step.group === 'keeperFundingSignature') {
      await provider.confirm(p.transferId, {routeInitSignatures:[], keeperFundingSignature:step.signature});
    }
    if (step.group.endsWith('Signatures')) {
      (p.signatures[step.group] ??= []).push(step.signature);
    } else {
      p.signatures[step.group] = step.signature;
    }
    p.steps.shift();
    save();
    return {stage:'continue'};
  }
  if (!chain && await rpc.finalizedHeight() > p.lastValidBlockHeight) {
    delete p.steps;
    save();
    return {stage:'continue'};
  }
  if (!step.signature) return {stage:'sign', unsigned:step.bytes, group:step.group};
  if (!chain) {
    const signature = await rpc.send(step.signed);
    requireValue(signature === step.signature, 'RPC returned an unexpected signature.');
  }
  return {stage:'confirming', signature:step.signature};
}
