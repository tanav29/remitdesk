import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import test from "node:test";
import { compileTransaction, getBase64EncodedWireTransaction, getTransactionDecoder } from "@solana/transactions";
import bs58 from "bs58";
import { advance, bundleSteps, inspectSigned, makeRpc } from "./payments.mjs";

function testSigner() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { address: bs58.encode(publicKey.export({ format: "der", type: "spki" }).subarray(-32)), privateKey };
}

// Nonpaying memo transactions, synthetic blockhashes and ephemeral in-memory keys.
// Both the chain and the provider are substituted at the public advance() boundary.
function testTransaction(owner, { version = 0, cosigner } = {}) {
  const tx = compileTransaction({
    version, feePayer: { address: owner.address },
    lifetimeConstraint: { blockhash: bs58.encode(randomBytes(32)), lastValidBlockHeight: 150n },
    instructions: [{
      programAddress: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
      accounts: cosigner ? [{ role: 2, address: cosigner.address }] : [],
      data: Buffer.from("RemitDesk test")
    }]
  });
  const signatures = { ...tx.signatures };
  if (cosigner) signatures[cosigner.address] = sign(null, tx.messageBytes, cosigner.privateKey);
  const unsigned = getBase64EncodedWireTransaction({ ...tx, signatures });
  const signature = sign(null, tx.messageBytes, owner.privateKey);
  const signed = getBase64EncodedWireTransaction({ ...tx, signatures: { ...signatures, [owner.address]: signature } });
  return { unsigned, signed, signature: bs58.encode(signature) };
}

function fixture() {
  const owner = testSigner();
  const keeper = testTransaction(owner);
  const route = testTransaction(owner, { cosigner: testSigner() });
  const orchestrator = testTransaction(owner, { version: "legacy" });
  const session = testTransaction(owner, { cosigner: testSigner() });
  const bundle = {
    keeperFundingTx: keeper.unsigned, routeInitTxs: [{ base64: route.unsigned }],
    orchestratorInitTx: orchestrator.unsigned, sessionInitTxs: [session.unsigned],
    dispersionInitTxs: [], lastValidBlockHeight: 150
  };
  const invoice = { payment: { transferId: 71, owner: owner.address, signatures: { routeInitSignatures: [] } } };
  const confirmations = [];
  const sends = [];
  const transactions = [keeper, route, orchestrator, session];
  const landed = new Set();
  const context = {
    provider: {
      async prepare() { return { preparedTxs: bundle }; },
      async confirm(id, signatures) {
        assert.equal(id, 71);
        confirmations.push(structuredClone(signatures));
        return { transfer: { id, status: signatures.routeInitSignatures.length ? "processing" : "awaiting_signature" } };
      }
    },
    rpc: {
      async checkNetwork() {},
      async finalizedHeight() { return 100; },
      async status(signature) { return landed.has(signature) ? { confirmationStatus: "confirmed", err: null } : null; },
      async send(bytes) {
        const tx = transactions.find(tx => tx.signed === bytes);
        assert.ok(tx);
        sends.push(bytes);
        return tx.signature;
      }
    },
    save() {}
  };
  return { owner, invoice, context, transactions, confirmations, sends, landed, bundle };
}

test("accepts exact signed legacy and v0 messages, including provider cosignatures", () => {
  const owner = testSigner();
  for (const version of ["legacy", 0]) {
    const tx = testTransaction(owner, { version, cosigner: testSigner() });
    assert.equal(inspectSigned(tx.unsigned, tx.signed, owner.address), tx.signature);
  }
});

test("a wallet response must preserve an ephemeral provider signature", () => {
  const owner = testSigner();
  const cosigner = testSigner();
  const tx = testTransaction(owner, { cosigner });
  const decoded = getTransactionDecoder().decode(Buffer.from(tx.signed, "base64"));
  const incomplete = getBase64EncodedWireTransaction({
    ...decoded, signatures: { ...decoded.signatures, [cosigner.address]: null }
  });
  assert.throws(() => inspectSigned(tx.unsigned, incomplete, owner.address), /co-signature/);
});

test("an unconnected payer cannot advance an invoice or commit signed bytes", async () => {
  const { invoice, context, transactions, sends } = fixture();
  const signed = testTransaction(testSigner()).signed;
  assert.equal((await advance(invoice, context)).unsigned, transactions[0].unsigned);
  await assert.rejects(advance(invoice, context, { signed }));
  assert.equal(invoice.payment.steps[0].signature, undefined);
  assert.equal(sends.length, 0);
});

test("keeper is reported after chain confirmation before any setup signatures are requested", async () => {
  const { invoice, context, transactions, confirmations, landed, sends } = fixture();
  for (const [index, tx] of transactions.entries()) {
    const prompt = await advance(invoice, context);
    assert.equal(prompt.stage, "sign");
    assert.equal(prompt.unsigned, tx.unsigned);
    if (index > 0) assert.deepEqual(confirmations, [{ routeInitSignatures: [], keeperFundingSignature: transactions[0].signature }]);
    assert.equal((await advance(invoice, context, { signed: tx.signed })).stage, "confirming");
    assert.equal(confirmations.length, index === 0 ? 0 : 1);
    landed.add(tx.signature);
    assert.equal((await advance(invoice, context)).stage, "continue");
  }
  assert.equal((await advance(invoice, context)).stage, "submitted");
  assert.equal(invoice.payment.submitted, true);
  assert.deepEqual(sends, transactions.map(tx => tx.signed));
  assert.deepEqual(confirmations[1], {
    keeperFundingSignature: transactions[0].signature,
    routeInitSignatures: [transactions[1].signature],
    orchestratorInitSignature: transactions[2].signature,
    sessionInitSignatures: [transactions[3].signature]
  });
});

test("an uncertain broadcast retries the saved bytes after restart", async () => {
  const { invoice, context, transactions, sends } = fixture();
  let persisted;
  context.save = () => { persisted = structuredClone(invoice); };
  const originalSend = context.rpc.send;
  context.rpc.send = async bytes => {
    assert.equal(persisted.payment.steps[0].signed, bytes);
    await originalSend(bytes);
    throw new Error("connection lost");
  };
  await advance(invoice, context);
  await assert.rejects(advance(invoice, context, { signed: transactions[0].signed }), /connection lost/);
  context.rpc.send = originalSend;
  const resumed = await advance(persisted, context);
  assert.equal(resumed.signature, transactions[0].signature);
  assert.deepEqual(sends, [transactions[0].signed, transactions[0].signed]);
});

test("expired blockhash refreshes the provider bundle and skips a funded keeper", async () => {
  const { invoice, context, transactions, bundle, landed, sends } = fixture();
  const [keeper, route] = transactions;
  await advance(invoice, context);
  await advance(invoice, context, { signed: keeper.signed });
  landed.add(keeper.signature);
  await advance(invoice, context);
  context.rpc.finalizedHeight = async () => 151;
  assert.equal((await advance(invoice, context)).stage, "continue");
  assert.equal(invoice.payment.steps, undefined);
  context.provider.prepare = async () => ({ preparedTxs: { ...bundle, keeperFundingTx: null, lastValidBlockHeight: 250 } });
  const resumed = await advance(invoice, context);
  assert.equal(resumed.unsigned, route.unsigned);
  assert.equal(invoice.payment.signatures.keeperFundingSignature, keeper.signature);
  assert.deepEqual(sends, [keeper.signed]);
});

test("retries a lost keeper acknowledgment before offering the route", async () => {
  const { invoice, context, transactions, sends, landed, confirmations } = fixture();
  const [keeper, route] = transactions;
  await advance(invoice, context);
  await advance(invoice, context, { signed: keeper.signed });
  landed.add(keeper.signature);
  const normalConfirm = context.provider.confirm;
  context.provider.confirm = async () => { throw new Error("acknowledgment unavailable"); };
  await assert.rejects(advance(invoice, context), /acknowledgment unavailable/);
  assert.equal(invoice.payment.steps[0].signature, keeper.signature);
  context.provider.confirm = normalConfirm;
  assert.equal((await advance(invoice, context)).stage, "continue");
  assert.equal((await advance(invoice, context)).unsigned, route.unsigned);
  assert.equal(confirmations.length, 1);
  assert.deepEqual(sends, [keeper.signed]);
});

test("resume accepts a provider response with fully confirmed transaction groups", () => {
  assert.deepEqual(bundleSteps({
    keeperFundingTx: null, routeInitTxs: null, orchestratorInitTx: null,
    sessionInitTxs: null, lastValidBlockHeight: 199, resume: { nothingToDo: true }
  }), []);
});

test("matches the full genesis hash returned by each official cluster", async t => {
  for (const [network, result] of [
    ["mainnet", "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"],
    ["devnet", "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"]
  ]) {
    const mock = t.mock.method(globalThis, "fetch", async (_url, options) => {
      assert.equal(JSON.parse(options.body).method, "getGenesisHash");
      return Response.json({ result });
    });
    await makeRpc("https://rpc.invalid", network).checkNetwork();
    await assert.rejects(makeRpc("https://rpc.invalid", network === "mainnet" ? "devnet" : "mainnet").checkNetwork());
    mock.mock.restore();
  }
});
