# MeterMyData

See how much of the data you received was a repeat. Free. Runs on your machine. Nothing is uploaded.

```
npx metermydata --allow api.openai.com
OPENAI_BASE_URL=http://127.0.0.1:7777/https://api.openai.com/v1   # then use your SDK as usual, Ctrl-C for the report
```

Or drop a HAR file on the page at https://www.metermydata.com/app/, or `npx metermydata har traffic.har`.

Windows PowerShell blocks `npx.ps1` by default ("running scripts is disabled on this system"). Use `npx.cmd metermydata`, or allow local scripts once with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

## What it does

It cuts every response into content-defined chunks (configuration `mmd-cdc-v1`, frozen), fingerprints each chunk with SHA-256, and counts how many bytes from the same host you had already received. The report shows repeated bytes, repeat percentage, decoded and wire bytes (labelled observed, estimated or unavailable), the provider's billing basis, and, only for providers that bill by bytes and only after you confirm your own rate, an estimate of what the repeats cost. Everything else gets a percentage and nothing more.

## What it does not do

No uploads, no telemetry, no accounts. No ledger, signatures, settlement, payments or encryption. No dollar claims without a byte billing basis and a rate you confirmed. Repeats are never counted across hosts.

## Three ways in

- **Browser:** drop a HAR exported with bodies (Chrome: "Save all as HAR with content").
- **Forwarder:** `npx metermydata --allow <host>`; point your SDK's base URL at `http://127.0.0.1:7777/https://<host>/...`. It streams every byte through untouched (compressed and SSE included), meters a decompressed copy, binds to 127.0.0.1 only, talks only to hosts you name, follows no redirects itself, and rewrites allowlisted redirects back through itself. Hostname-signed requests (AWS SigV4) do not work through it.
- **Offline:** `npx metermydata dir ./responses --host feed.example.com`.

`--history` keeps a per-host fingerprint history in `~/.metermydata/history.json` (capped, oldest-first eviction) so repeats across days are found; the report says how much history it had.

## Build and test

```
npm ci && npm run build && npm test
```

The CI matrix runs the frozen chunking vectors and the fixture-HAR parity check on macOS, Windows and Ubuntu with Node 20 and 22.

## Licence

MeterMyData License v1.0 (LICENSE.md): the MIT License plus three clarifications: no trademark rights, no patent rights (with defensive termination), and measurements are not invoices. SPDX: `LicenseRef-MeterMyData-1.0`. Contributions under the DCO (CONTRIBUTING.md).

