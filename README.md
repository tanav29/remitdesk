# RemitDesk

Pay an approved vendor bill in Solana USDC and match its delivery to the invoice. Enter what the vendor is owed, preview the payer's total, and retain a receipt with the MultiHopper transfer ID and recorded chain signatures.

**[Open the interactive demo](https://rawcdn.githack.com/tanav29/remitdesk/81ad7803f28fdd4c97373fb59395c864ed4e3d60/index.html)** · **[Watch the 58-second walkthrough](https://raw.githubusercontent.com/tanav29/remitdesk/main/docs/remitdesk-demo.mp4)** · **[Request a pilot](https://github.com/tanav29/remitdesk/issues/new?template=pilot.yml)**

The public demo keeps sample invoices in the current browser tab. Choose **New invoice**, leave exact delivery selected, preview the quote, simulate payment and download the receipt. The sample ledger and demo video illustrate the workflow. Production customer and volume figures have yet to be established.

## Run the desk

Install Node.js 24 or newer. The default server starts a demo on the loopback interface, with an independent temporary ledger for each browser session.

```sh
npm ci --ignore-scripts
npm test
npm start
```

Open http://127.0.0.1:4173. For the standalone public simulator, run `npm run build:pages` and serve the resulting `dist-pages/` directory from a static host.

## Connect a private operator workspace

Use a separate single-process service and SQLite database for each paying team and each network. Anyone with the operator token can access that workspace's invoices. Deploy behind HTTPS and mount persistent storage for the database before sharing it with a pilot operator.

| Environment variable | Configuration |
| --- | --- |
| MULTIHOPPER_API_KEY | Environment-specific integration key from the MultiHopper dashboard. Keep it in the server secret store. |
| MULTIHOPPER_NETWORK | `devnet` (default) or `mainnet`. Test with the devnet USDC mint and devnet SOL first. |
| REMITDESK_MODE | Set to `partner` on a private deployment so a missing key causes startup to fail. |
| REMITDESK_OPERATOR_TOKEN | Generate a unique random secret of at least 32 characters. Use the sign-in form to unlock the workspace. |
| REMITDESK_DB | Database file on a persistent volume. Defaults to `data/<network>.sqlite`. Back up with SQLite's online backup facility. |
| SOLANA_RPC_URL | Solana JSON-RPC endpoint for the selected network. The server verifies the cluster genesis hash before broadcast. |
| HOST / PORT | Defaults are `127.0.0.1` and `4173`. The container binds to all interfaces. |

The Dockerfile contains the full private service. Build with `docker build -t remitdesk .` and run with `docker run --env-file /path/to/private.env -v remitdesk-data:/app/data -p 127.0.0.1:4173:4173 remitdesk`. Supply these environment variables from the host or a secret manager. Keep the private environment file outside the repository and bind-mounted public directories.

## How a payment works

1. The operator records a vendor, unique invoice reference, destination wallet and amount. Exact delivery is the default. A fixed gross budget is also available.
2. The server estimates the three-hop, five-minute route. For exact delivery it adjusts gross USDC in integer base units until the provider's estimated net equals the invoice amount. The quote displays token fees and required upfront SOL, including rent where applicable.
3. A Wallet Standard browser wallet connects the payer. The server creates the transfer using a persistent external ID and verifies the returned recipient, payer, mint and amount. Exact-delivery invoices also enforce the target vendor amount again at quote lock.
4. The payer checks the locked quote and reviews each transaction in the wallet. RemitDesk verifies the signed message and payer signature, preserves provider co-signatures, and saves signed bytes before sending. The keeper funding confirmation reaches MultiHopper before the remaining route setup transactions. Resume an interrupted payment from the same invoice and payer.
5. **Check settlement** refreshes the MultiHopper status. A completed route yields a receipt with the invoice reference, network, amount and available chain evidence. If a route is expired, failed or recoverable, inspect the original transfer in the provider dashboard before arranging a replacement. Reconcile the provider's fees, refunds and settlement timestamps before reporting campaign volume.

The service uses Circle USDC, one destination per invoice and a single operator per deployment. The server calls the authenticated REST API. Signing keys stay in the wallet. Authenticated end-to-end execution still requires an environment-specific partner key and a funded test wallet. The automated suite uses provider and RPC fixtures, including locally signed transactions.

[MultiHopper quickstart](https://dev-docs.multihopper.com/quickstart) · [Transaction preparation](https://dev-docs.multihopper.com/api-reference/transfers/prepare) · [Broadcast confirmation](https://dev-docs.multihopper.com/api-reference/transfers/confirm-broadcast)

## Review and evidence

The operator can call authenticated `GET /api/evidence` to export stored receipts and the provider's integration usage summary. The summary is account-level and uses the provider's default reporting period. Verify dates, customer business purpose and attribution against the sponsor's records before calculating eligible volume. Customer documents belong in private reviewer access.

[Private-pilot plan](docs/pilot.md) · [Submission and evidence worksheet](docs/submission.md) · [Sponsor criteria and measurement window](https://business.multihopper.com/build-and-route/)
