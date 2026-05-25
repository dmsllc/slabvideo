# AGENTS.md

## Cursor Cloud specific instructions

### Overview

**slabvideo** is a standalone TypeScript CLI script (`scripts/generate-creatomate-feed.ts`) that generates a Creatomate video feed CSV for Pokémon PSA 10 graded card market alerts. It is **not** a web application — there are no servers to start.

### Runtime

- The script runs via `tsx` (TypeScript Execute): `tsx scripts/generate-creatomate-feed.ts`
- Node.js v22+ is required (for native `fetch` support).
- There is no `package.json` — `tsx`, `typescript`, and `@types/node` are installed globally.

### Type-checking

Because there is no local `package.json` or `tsconfig.json`, type-checking requires pointing `tsc` at the global `@types/node`:

```sh
GLOBAL_NODE_MODULES="$(npm root -g)"
tsc --noEmit --strict --target ES2022 --module nodenext --moduleResolution nodenext \
  --typeRoots "$GLOBAL_NODE_MODULES/@types" --types node \
  scripts/generate-creatomate-feed.ts
```

### Running the script

```sh
tsx scripts/generate-creatomate-feed.ts
```

The script reads PriceCharting snapshot data from `data/pricecharting-snapshots/` (JSON or CSV files with dates in the filename or content). It outputs `creatomate-market-alert-feed.csv` and `creatomate-market-alert-debug.json` in the working directory.

### Environment variables (all optional)

| Variable | Purpose |
|---|---|
| `PRICECHARTING_API_TOKEN` / `pricecharting_API_key` | Refresh current card prices via PriceCharting API |
| `SOLDCOMPS_API_KEY` | Look up sold listing images from SoldComps |
| `SERPAPI_API_KEY` | Fallback image search via eBay sold results |

Without API keys, the script still runs but cannot find listing images, so no cards will appear in the final CSV feed. The debug JSON will show which candidates were identified and why they were skipped.

### Testing

There is no automated test suite. Verify correctness by:
1. Running `tsx scripts/generate-creatomate-feed.ts` with snapshot data in `data/pricecharting-snapshots/`
2. Inspecting `creatomate-market-alert-debug.json` for candidate selection logic and warnings
3. Type-checking with `tsc` as described above

### Gotchas

- Snapshot data files must contain dates (either in the JSON content or in the filename, e.g. `2026-05-20-snapshot.json`) for the lookback window calculation to work.
- The script expects snapshot files at specific paths (see `SNAPSHOT_PATHS` in the source). The default search path is `data/pricecharting-snapshots/`.
- No `.env` file loading — all configuration is via environment variables.
