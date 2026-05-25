#!/usr/bin/env tsx

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CSV_COLUMNS,
  type TargetCard,
  computePriceMove,
  defaultSnapshotPaths,
  errorMessage,
  fetchPriceChartingPsa10Cents,
  findBestListingImage,
  formatMoney,
  formatPercentChange,
  formatPriceMoveText,
  isMissingCell,
  isUsableImageUrl,
  loadStoredSnapshots,
  matchesFeedRow,
  maybeCachePublicImage,
  parseFeedCsv,
  resolveApiEnv,
  resolveProductId,
  toCsvLine,
} from "./lib/marketFeedHelpers.ts";

const ROOT = process.cwd();
const INPUT_CSV = resolve(
  ROOT,
  process.env.CREATOMATE_INPUT_CSV ?? "data/creatomate-market-alert-feed.csv",
);
const OUTPUT_CSV = process.env.CREATOMATE_OUTPUT_CSV ?? "/tmp/slabfolio-creatomate-market-alert-feed-populated.csv";
const OUTPUT_DEBUG = process.env.CREATOMATE_DEBUG_JSON ?? "/tmp/slabfolio-creatomate-market-alert-debug.json";

const TARGET_CARDS: TargetCard[] = [
  {
    cardName: "Gengar & Mimikyu GX",
    cardNumber: "#165",
    displayName: "Gengar & Mimikyu GX #165 • PSA 10",
    productId: "962963",
  },
  {
    cardName: "Pikachu with Grey Felt Hat",
    cardNumber: "#085",
    displayName: "Pikachu with Grey Felt Hat #085 • PSA 10",
    productId: "5834844",
  },
  {
    cardName: "Charizard ex",
    cardNumber: "#199",
    displayName: "Charizard ex #199 • PSA 10",
    productId: "5809582",
  },
  {
    cardName: "Charizard V",
    cardNumber: "#050",
    displayName: "Charizard V #050 • PSA 10",
    productId: "1368342",
  },
  {
    cardName: "Umbreon VMAX",
    cardNumber: "#215",
    displayName: "Umbreon VMAX #215 • PSA 10",
    productId: "2513024",
  },
  {
    cardName: "Giratina V",
    cardNumber: "#186",
    displayName: "Giratina V #186 • PSA 10",
    productId: "4050103",
  },
  {
    cardName: "Rayquaza VMAX",
    cardNumber: "#218",
    displayName: "Rayquaza VMAX #218 • PSA 10",
    productId: "2513027",
  },
  {
    cardName: "Lugia V",
    cardNumber: "#186",
    displayName: "Lugia V #186 • PSA 10",
    productId: "4277307",
  },
  {
    cardName: "Magikarp",
    cardNumber: "#203",
    displayName: "Magikarp #203 • PSA 10",
    productId: "5287492",
  },
  {
    cardName: "Mew ex",
    cardNumber: "#232",
    displayName: "Mew ex #232 • PSA 10",
    productId: "6277151",
  },
];

type RowResult = {
  card: TargetCard;
  displayName: string;
  imageUrl: string;
  listingUrl: string;
  imageSource: string;
  oldPrice: string;
  newPrice: string;
  percentChange: string;
  priceSource: string;
  verified: boolean;
  issues: string[];
};

async function main() {
  const startedAt = new Date().toISOString();
  const warnings: string[] = [];
  const env = resolveApiEnv();

  if (!env.priceChartingToken) {
    warnings.push("PRICECHARTING_API_TOKEN is not set; PriceCharting lookups will be skipped.");
  }
  if (!env.soldCompsApiKey) {
    warnings.push("SOLDCOMPS_API_KEY is not set; SoldComps listing and comp lookups will be skipped.");
  }
  if (!env.serpApiKey) {
    warnings.push("SERPAPI_API_KEY is not set; SerpAPI image fallback will be skipped.");
  }

  const inputRows = loadInputRows();
  const snapshots = loadStoredSnapshots(defaultSnapshotPaths(ROOT), warnings);
  const results: RowResult[] = [];
  const outputRows: string[][] = [CSV_COLUMNS.slice()];

  for (const card of TARGET_CARDS) {
    const inputRow = inputRows.find((row) => matchesFeedRow(card, row["Text-D72"])) ?? buildDefaultInputRow(card);
    const issues: string[] = [];
    const productId = await resolveProductId(card, snapshots, env.priceChartingToken, warnings);

    let priceMove = await computePriceMove(card, productId, snapshots, env, warnings);
    if (!priceMove && productId && env.priceChartingToken) {
      const current = await fetchPriceChartingPsa10Cents(productId, env.priceChartingToken);
      if (current) {
        issues.push("Only current PriceCharting PSA 10 price available; no verified 30-day prior price.");
      }
    }

    const { listing, imageUrl: rawImageUrl, imageSource } = await findBestListingImage(
      card,
      productId,
      env,
      warnings,
    );
    let imageUrl = rawImageUrl;
    if (imageUrl && isUsableImageUrl(imageUrl)) {
      imageUrl = await maybeCachePublicImage(imageUrl, card, warnings);
    } else {
      imageUrl = "";
      issues.push("No usable sold listing image from SoldComps or SerpAPI.");
    }

    const imageCell = isMissingCell(inputRow["Image-JZ4"]) ? imageUrl : inputRow["Image-JZ4"];
    const priceMoveCell = isMissingCell(inputRow["Text-PLR"]) && priceMove ? formatPriceMoveText(priceMove) : inputRow["Text-PLR"];
    const percentCell =
      isMissingCell(inputRow["Text-BJJ"]) && priceMove ? formatPercentChange(priceMove.percentChange) : inputRow["Text-BJJ"];

    if (isMissingCell(imageCell)) issues.push("Image-JZ4 still empty.");
    if (isMissingCell(priceMoveCell)) issues.push("Text-PLR still empty.");
    if (isMissingCell(percentCell)) issues.push("Text-BJJ still empty.");
    if (!priceMove) issues.push("Price move could not be verified from snapshots or sold comps.");

    const verified = issues.length === 0;
    const result: RowResult = {
      card,
      displayName: card.displayName,
      imageUrl: imageCell,
      listingUrl: listing?.listingUrl ?? "",
      imageSource,
      oldPrice: priceMove ? formatMoney(priceMove.priorPriceCents) : "",
      newPrice: priceMove ? formatMoney(priceMove.currentPriceCents) : "",
      percentChange: priceMove ? formatPercentChange(priceMove.percentChange) : "",
      priceSource: priceMove?.source ?? "unavailable",
      verified,
      issues,
    };
    results.push(result);

    outputRows.push([
      imageCell,
      inputRow["Text-99R"] || pickHook(priceMove?.percentChange),
      inputRow["Text-D72"] || card.displayName,
      priceMoveCell,
      percentCell,
      inputRow["Text-2ZV"] || "in the last 30 days",
    ]);
  }

  writeFileSync(OUTPUT_CSV, outputRows.map(toCsvLine).join("\n") + "\n");
  writeFileSync(
    OUTPUT_DEBUG,
    JSON.stringify(
      {
        generatedAt: startedAt,
        inputCsv: INPUT_CSV,
        outputCsv: OUTPUT_CSV,
        snapshotPathsChecked: defaultSnapshotPaths(ROOT),
        warnings,
        rows: results,
        unverifiedRows: results.filter((row) => !row.verified).map((row) => row.displayName),
      },
      null,
      2,
    ) + "\n",
  );

  printSummary(results, warnings);
  console.log(`\nWrote ${OUTPUT_CSV}`);
  console.log(`Wrote ${OUTPUT_DEBUG}`);
}

function loadInputRows(): Array<Record<(typeof CSV_COLUMNS)[number], string>> {
  if (!existsSync(INPUT_CSV)) {
    return TARGET_CARDS.map(buildDefaultInputRow);
  }
  return parseFeedCsv(readFileSync(INPUT_CSV, "utf8"));
}

function buildDefaultInputRow(card: TargetCard): Record<(typeof CSV_COLUMNS)[number], string> {
  return {
    "Image-JZ4": "",
    "Text-99R": "",
    "Text-D72": card.displayName,
    "Text-PLR": "",
    "Text-BJJ": "",
    "Text-2ZV": "in the last 30 days",
  };
}

function pickHook(percentChange?: number): string {
  if (percentChange === undefined) return "THIS CARD JUST EXPLODED";
  if (percentChange >= 75) return "THIS CARD WENT PARABOLIC";
  if (percentChange >= 40) return "THIS SLAB JUST SURGED";
  return "THIS CARD JUST EXPLODED";
}

function printSummary(results: RowResult[], warnings: string[]) {
  console.log("\n=== Creatomate market alert feed (10 rows) ===\n");
  for (const [index, row] of results.entries()) {
    console.log(`${index + 1}. ${row.displayName}`);
    console.log(`   old price: ${row.oldPrice || "(missing)"}`);
    console.log(`   new price: ${row.newPrice || "(missing)"}`);
    console.log(`   percent change: ${row.percentChange || "(missing)"}`);
    console.log(`   listing URL: ${row.listingUrl || "(missing)"}`);
    console.log(`   image URL: ${row.imageUrl || "(missing)"}`);
    console.log(`   price source: ${row.priceSource}`);
    console.log(`   image source: ${row.imageSource}`);
    if (!row.verified) {
      console.log(`   verification issues: ${row.issues.join("; ")}`);
    }
    console.log("");
  }

  const unverified = results.filter((row) => !row.verified);
  if (unverified.length) {
    console.log("Rows that could not be fully verified:");
    for (const row of unverified) {
      console.log(`- ${row.displayName}: ${row.issues.join("; ")}`);
    }
  } else {
    console.log("All 10 rows were fully verified.");
  }

  if (warnings.length) {
    console.log("\nWarnings:");
    for (const warning of warnings) {
      console.log(`- ${warning}`);
    }
  }
}

main().catch((error) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
