import assert from "node:assert/strict";
import test from "node:test";
import { createMultiHopper, formatUsdc, isSolanaAddress, parseUsdc } from "./adapter.mjs";

const sourceOwner = "6cyrbpZcgTuMc7anB4AKKk5FRou2K5Vs7hpUzNvVFp8R";
const recipientWallet = "3oU8mn8Et7Bsx6a26NGvPESygFJRCTS4Zzj6BKqjrqVg";
const externalId = "test-invoice.001";
const amountRaw = "107000001";
const input = { sourceOwner, recipientWallet, externalId, amountRaw };
const providerTransfer = {
  id: 191, status: "quote", ...input,
  tokenMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", recipientReceivesRaw: "106467662"
};

function harness(responses, options = {}) {
  const calls = [];
  const adapter = createMultiHopper({
    apiKey: "mh_test_fixture", ...options,
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options, body: options.body && JSON.parse(options.body) });
      const response = responses.shift();
      assert.ok(response, "unexpected fetch: " + url);
      return Response.json(response.data, { status: response.status ?? 200 });
    }
  });
  return { calls, adapter };
}

test("USDC input remains exact through the full u64 range", () => {
  assert.equal(parseUsdc("107.000001"), amountRaw);
  assert.equal(parseUsdc("18446744073709.551615"), "18446744073709551615");
  assert.equal(formatUsdc("18446744073709551615"), "18446744073709.551615");
  assert.equal(formatUsdc("1010000"), "1.01");
  assert.equal(formatUsdc("0"), "0");
  for (const value of ["18446744073709.551616", "1e-5", "0", "1.0000001", "-1", "0.1x", 1.5]) {
    assert.throws(() => parseUsdc(value));
  }
});

test("validates decoded address size, including leading zero bytes", () => {
  assert.ok(isSolanaAddress(sourceOwner));
  assert.ok(isSolanaAddress("1".repeat(32)));
  for (const invalid of ["1".repeat(31), "1".repeat(33), "0".repeat(44), "z".repeat(44)]) {
    assert.equal(isSolanaAddress(invalid), false);
  }
});

test("estimates the same configured route as creation, preserving recipient and gross amount", async () => {
  const { calls, adapter } = harness([{ data: { tokens: { netDeliveredRaw: "106467662" } } }, { data: providerTransfer }]);
  const estimate = await adapter.estimate(input);
  const quote = await adapter.create(input);
  assert.equal(estimate.tokens.netDeliveredRaw, quote.recipientReceivesRaw);
  assert.equal(calls[0].url, "https://devnet.multihopper.com/api/v1/transfers/estimate");
  assert.equal(calls[1].url, "https://devnet.multihopper.com/api/v1/transfers");
  assert.deepEqual(calls[0].body, { tokenMint: providerTransfer.tokenMint, tokenDecimals: 6, amountRaw, hops: 3, arrivalSeconds: 300 });
  assert.deepEqual(calls[1].body, {
    ...calls[0].body, tokenSymbol: "USDC", amountTokens: "107.000001", sourceOwner, recipientWallet, externalId
  });
  for (const call of calls) {
    assert.equal(call.headers["x-api-key"], "mh_test_fixture");
    assert.match(call.headers["Idempotency-Key"], /^[A-Za-z0-9._-]{8,64}$/);
    assert.equal(call.redirect, "error");
  }
});

test("a replayed create recovers the existing provider transfer", async () => {
  const { calls, adapter } = harness([
    { data: providerTransfer },
    { status: 409, data: { error: { code: "MH_033" } } },
    { data: providerTransfer }
  ]);
  await adapter.create(input);
  assert.equal((await adapter.create(input)).id, 191);
  assert.equal(calls[0].headers["Idempotency-Key"], calls[1].headers["Idempotency-Key"]);
  assert.equal(calls[2].url, "https://devnet.multihopper.com/api/v1/transfers/by-external/test-invoice.001");
});

test("rejects a reused transfer reference that points to a different payment", async () => {
  const { adapter } = harness([
    { status: 409, data: { error: { code: "MH_033" } } },
    { data: { ...providerTransfer, amountRaw: "1" } }
  ]);
  await assert.rejects(adapter.create(input), { code: "TRANSFER_MISMATCH" });
});

test("uses new prepare keys for resumable bundles, and accepts split broadcast acknowledgements", async () => {
  const { calls, adapter } = harness(Array.from({ length: 5 }, () => ({ data: { transfer: { id: 191 } } })));
  await adapter.prepare(191);
  await adapter.prepare(191);
  const signature = "1".repeat(64);
  await adapter.confirm(191, { routeInitSignatures: [], keeperFundingSignature: signature });
  await adapter.confirm(191, { routeInitSignatures: [signature], orchestratorInitSignature: signature, sessionInitSignatures: [] });
  await adapter.status(191);
  assert.notEqual(calls[0].headers["Idempotency-Key"], calls[1].headers["Idempotency-Key"]);
  assert.ok(calls[0].url.endsWith("/191/prepare"));
  assert.ok(calls[2].url.endsWith("/191/confirm-broadcast"));
  assert.deepEqual(calls[2].body, { routeInitSignatures: [], keeperFundingSignature: signature });
  assert.equal(calls[4].method, "GET");
  assert.equal(calls[4].headers["Idempotency-Key"], undefined);
});

test("rejects malformed input before requesting MultiHopper", async () => {
  const { calls, adapter } = harness([]);
  await assert.rejects(adapter.status("../usage"));
  await assert.rejects(adapter.confirm(1, { routeInitSignatures: ["not-a-signature"] }));
  await assert.rejects(adapter.estimate({ amountRaw: "120.3" }));
  await assert.rejects(adapter.create({ ...input, sourceOwner: recipientWallet }));
  await assert.rejects(adapter.create({ ...input, externalId: "../?test" }));
  await assert.rejects(adapter.usage({ fromDate: "invalid" }));
  assert.equal(calls.length, 0);
  assert.throws(() => createMultiHopper({ network: "testnet", apiKey: "mh_test_fixture" }));
  assert.throws(() => createMultiHopper({ network: "mainnet", apiKey: "mh_test_fixture" }));
});

test("mainnet uses Circle's production mint and sends period filters to the usage endpoint", async () => {
  const { calls, adapter } = harness([{ data: {} }, { data: { completedTransfers: 0 } }], {
    network: "mainnet", apiKey: "mh_live_fixture"
  });
  await adapter.estimate(input);
  await adapter.usage({ fromDate: "2026-11-15", toDate: "2026-11-18" });
  assert.equal(calls[0].body.tokenMint, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const url = new URL(calls[1].url);
  assert.equal(url.origin, "https://multihopper.com");
  assert.equal(url.pathname, "/api/v1/usage");
  assert.equal(url.searchParams.get("fromDate"), "2026-11-15T00:00:00.000Z");
});

test("surface the machine-readable error code without echoing credentials or financial metadata", async () => {
  const { adapter } = harness([{ status: 409, data: { error: { code: "MH_040", message: "secret mh_test_fixture" } } }]);
  await assert.rejects(adapter.prepare(191), error => {
    assert.equal(error.code, "MH_040");
    assert.equal(error.status, 409);
    assert.doesNotMatch(error.message, /secret|fixture/);
    return true;
  });
});
