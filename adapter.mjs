import { createHash, randomUUID } from "node:crypto";

// Circle-issued USDC on each Solana cluster. The API credential stays on this server.
const networks = new Map([
  ["devnet", {
    base: "https://devnet.multihopper.com/api/v1",
    keyPrefix: "mh_test_",
    mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
  }],
  ["mainnet", {
    base: "https://multihopper.com/api/v1",
    keyPrefix: "mh_live_",
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
  }]
]);

const maxRaw = (1n << 64n) - 1n;
const base58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58HasSize(text, size) {
  if (typeof text !== "string" || text.length < size || text.length > Math.ceil(size * Math.log(256) / Math.log(58))) return false;
  let value = 0n;
  for (const char of text) {
    const digit = base58.indexOf(char);
    if (digit === -1) return false;
    value = value * 58n + BigInt(digit);
  }
  const leadingZeroBytes = text.match(/^1*/)[0].length;
  const nonzeroBytes = value === 0n ? 0 : Math.ceil(value.toString(16).length / 2);
  return leadingZeroBytes + nonzeroBytes === size;
}

export function isSolanaAddress(text) {
  return base58HasSize(text, 32);
}

function validRaw(text) {
  return typeof text === "string" && /^(?:0|[1-9]\d{0,19})$/.test(text) && BigInt(text) <= maxRaw;
}

export function parseUsdc(text) {
  if (typeof text !== "string" || !/^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/.test(text)) {
    throw new TypeError("Enter a positive USDC amount with up to six decimals.");
  }
  const [whole, fraction = ""] = text.split(".");
  const raw = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (raw === 0n || raw > maxRaw) throw new RangeError("USDC amount is outside the supported range.");
  return raw.toString();
}

export function formatUsdc(raw) {
  if (!validRaw(raw)) throw new TypeError("Expected USDC base units as an unsigned integer string.");
  const padded = raw.padStart(7, "0");
  const fraction = padded.slice(-6).replace(/0+$/, "");
  return padded.slice(0, -6) + (fraction ? "." + fraction : "");
}

function transferPath(id) {
  if (!["string", "number"].includes(typeof id) || !/^[1-9]\d*$/.test(String(id)) || !Number.isSafeInteger(Number(id))) {
    throw new TypeError("A positive numeric transfer ID is required.");
  }
  return "/transfers/" + id;
}

function validateSignatures(input) {
  if (!input || !Array.isArray(input.routeInitSignatures)) throw new TypeError("Expected route initialization signatures.");
  const result = {};
  for (const field of ["routeInitSignatures", "sessionInitSignatures"]) {
    if (input[field] === undefined) continue;
    if (!Array.isArray(input[field]) || input[field].length > 64 || !input[field].every(sig => base58HasSize(sig, 64))) {
      throw new TypeError("Invalid transaction signature list.");
    }
    result[field] = input[field];
  }
  for (const field of ["keeperFundingSignature", "orchestratorInitSignature"]) {
    if (input[field] === undefined) continue;
    if (!base58HasSize(input[field], 64)) throw new TypeError("Invalid transaction signature.");
    result[field] = input[field];
  }
  return result;
}

export class MultiHopperError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = "MultiHopperError";
    this.status = status;
    this.code = code;
  }
}

export function createMultiHopper({ apiKey, network = "devnet", fetchImpl = fetch } = {}) {
  const config = networks.get(network);
  if (!config) throw new TypeError("Choose devnet or mainnet.");
  if (typeof apiKey !== "string" || !apiKey.startsWith(config.keyPrefix) || apiKey.length <= config.keyPrefix.length || /\s/.test(apiKey)) {
    throw new TypeError("Configure a MultiHopper API key for the selected network.");
  }

  async function request(path, { method = "GET", body, key } = {}) {
    const headers = { Accept: "application/json", "x-api-key": apiKey };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (method === "POST") headers["Idempotency-Key"] = key ?? randomUUID();
    let response;
    let data;
    try {
      response = await fetchImpl(config.base + path, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error", signal: AbortSignal.timeout(20_000)
      });
      data = await response.json();
    } catch {
      throw new MultiHopperError("MultiHopper did not return a readable response. Retry the same operation.", 502, "UPSTREAM_UNAVAILABLE");
    }
    if (!response.ok) {
      const code = typeof data?.error?.code === "string" && /^MH_\d{3}$/.test(data.error.code)
        ? data.error.code : "UPSTREAM_ERROR";
      // Do not send provider response bodies, request headers or credential strings to browsers or logs.
      throw new MultiHopperError("MultiHopper declined the request (" + code + ").", response.status, code);
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new MultiHopperError("MultiHopper returned an invalid response.", 502, "UPSTREAM_INVALID");
    }
    return data;
  }

  function paymentParameters(amountRaw) {
    if (!validRaw(amountRaw) || amountRaw === "0") throw new RangeError("Amount must be a positive integer in USDC base units.");
    return { tokenMint: config.mint, tokenDecimals: 6, amountRaw, hops: 3, arrivalSeconds: 300 };
  }

  return {
    network,
    tokenMint: config.mint,
    async estimate({ amountRaw }) {
      return request("/transfers/estimate", { method: "POST", body: paymentParameters(amountRaw) });
    },
    async create({ amountRaw, sourceOwner, recipientWallet, externalId }) {
      if (!isSolanaAddress(sourceOwner) || !isSolanaAddress(recipientWallet) || sourceOwner === recipientWallet) {
        throw new TypeError("Enter distinct, valid sender and recipient addresses.");
      }
      if (typeof externalId !== "string" || !/^[a-zA-Z0-9._-]{1,128}$/.test(externalId)) {
        throw new TypeError("Invalid invoice transfer reference.");
      }
      const body = {
        ...paymentParameters(amountRaw), tokenSymbol: "USDC", amountTokens: formatUsdc(amountRaw),
        sourceOwner, recipientWallet, externalId
      };
      // The invoice owner persists externalId before calling this method. A lost HTTP response
      // and process restart must address the same transfer on the provider.
      const key = createHash("sha256").update("create/" + externalId).digest("hex");
      let transfer;
      try {
        transfer = await request("/transfers", { method: "POST", body, key });
      } catch (error) {
        if (error.code !== "MH_033") throw error;
        transfer = await request("/transfers/by-external/" + encodeURIComponent(externalId));
      }
      const identity = ["amountRaw", "sourceOwner", "recipientWallet", "externalId", "tokenMint"];
      if (!Number.isSafeInteger(transfer.id) || transfer.id < 1 || identity.some(field => transfer[field] !== body[field])) {
        throw new MultiHopperError("Provider transfer does not match this invoice.", 502, "TRANSFER_MISMATCH");
      }
      return transfer;
    },
    async prepare(id) {
      // Every fresh prepare probes the chain and needs a new blockhash after expiry.
      return request(transferPath(id) + "/prepare", { method: "POST" });
    },
    async confirm(id, signatures) {
      return request(transferPath(id) + "/confirm-broadcast", { method: "POST", body: validateSignatures(signatures) });
    },
    async status(id) {
      return request(transferPath(id));
    },
    async usage({ fromDate, toDate } = {}) {
      const query = new URLSearchParams();
      for (const [name, date] of Object.entries({ fromDate, toDate })) {
        if (date === undefined) continue;
        const instant = new Date(date);
        if (!Number.isFinite(instant.getTime())) throw new TypeError("Invalid usage date.");
        query.set(name, instant.toISOString());
      }
      if (query.has("fromDate") && query.has("toDate") && query.get("fromDate") > query.get("toDate")) {
        throw new RangeError("Usage end date precedes start date.");
      }
      return request(query.size ? "/usage?" + query : "/usage");
    }
  };
}
