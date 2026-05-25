#!/usr/bin/env tsx

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type Row = Record<string, unknown>;

type PriceSnapshot = {
  cardName: string;
  cardNumber: string;
  consoleName: string;
  date: Date;
  genre: string;
  grade: "PSA 10";
  priceCents: number;
  productId: string;
  salesVolume: number;
  sourceFile: string;
};

type Candidate = {
  absoluteGainCents: number;
  cardName: string;
  cardNumber: string;
  consoleName: string;
  current: PriceSnapshot;
  currentPriceCents: number;
  grade: "PSA 10";
  percentChange: number;
  prior: PriceSnapshot;
  priorPriceCents: number;
  productId: string;
  salesVolume: number;
};

type Listing = {
  imageUrl: string;
  listingUrl: string;
  price?: number;
  soldDate?: string;
  source: "SoldComps" | "SerpAPI";
  title: string;
};

type DebugSelected = {
  "card name": string;
  "card number": string;
  grade: string;
  "old price": string;
  "new price": string;
  "percent change": string;
  "SoldComps listing URL": string;
  "SoldComps image URL if found": string;
  "SerpAPI image URL if used": string;
  "final image URL": string;
  "reason the card was selected": string;
};

const CSV_COLUMNS = ["Image-JZ4", "Text-99R", "Text-D72", "Text-PLR", "Text-BJJ", "Text-2ZV"] as const;
const ROOT = process.cwd();
const OUTPUT_CSV = resolve(ROOT, process.env.CREATOMATE_OUTPUT_CSV ?? "creatomate-market-alert-feed.csv");
const OUTPUT_DEBUG = resolve(ROOT, process.env.CREATOMATE_DEBUG_JSON ?? "creatomate-market-alert-debug.json");
const LOOKBACK_DAYS = Number(process.env.PRICECHARTING_LOOKBACK_DAYS ?? 30);
const LOOKBACK_TOLERANCE_DAYS = Number(process.env.PRICECHARTING_LOOKBACK_TOLERANCE_DAYS ?? 14);
const FEED_LIMIT = Number(process.env.CREATOMATE_FEED_LIMIT ?? 10);
const REFRESH_LIMIT = Number(process.env.PRICECHARTING_REFRESH_LIMIT ?? 40);
const MIN_CURRENT_CENTS = dollarsToCents(Number(process.env.MIN_CURRENT_PRICE ?? 100));
const MIN_PRIOR_CENTS = dollarsToCents(Number(process.env.MIN_PRIOR_PRICE ?? 50));
const MIN_GAIN_CENTS = dollarsToCents(Number(process.env.MIN_ABSOLUTE_GAIN ?? 50));
const MIN_GAIN_PERCENT = Number(process.env.MIN_GAIN_PERCENT ?? 20);
const PRICECHARTING_TOKEN = process.env.PRICECHARTING_API_TOKEN ?? process.env.pricecharting_API_key;
const SOLDCOMPS_API_KEY = process.env.SOLDCOMPS_API_KEY;
const SERPAPI_API_KEY = process.env.SERPAPI_API_KEY;
const SOLDCOMPS_API_URL = process.env.SOLDCOMPS_API_URL ?? "https://api.soldcomps.com/v1/search";
const PUBLIC_ASSET_DIR = process.env.PUBLIC_ASSET_DIR;
const PUBLIC_BASE_URL = trimTrailingSlash(process.env.PUBLIC_BASE_URL ?? "");

const SNAPSHOT_PATHS = [
  process.env.PRICECHARTING_HISTORY_PATH,
  "data/pricecharting-history.json",
  "data/pricecharting-history.csv",
  "data/pricecharting-snapshots",
  "pricecharting-history.json",
  "pricecharting-history.csv",
  "pricecharting-snapshots",
  "snapshots/pricecharting",
].filter(Boolean) as string[];

const EXCLUDED_LISTING_TERMS = [
  " lot ",
  " lots ",
  "bundle",
  "pack",
  "booster",
  "sealed",
  "proxy",
  "custom",
  "digital",
  "reprint",
  "damaged",
  "empty slab",
  "empty case",
  "case only",
  "label only",
  "slab case",
  "stand only",
  "mystery",
  "replica",
];

async function main() {
  const startedAt = new Date().toISOString();
  const warnings: string[] = [];
  const skipped: Array<Record<string, unknown>> = [];

  if (!PRICECHARTING_TOKEN) {
    warnings.push(
      "PRICECHARTING_API_TOKEN is not set; current prices will come only from local snapshots. Also checked legacy alias pricecharting_API_key.",
    );
  }
  if (!SOLDCOMPS_API_KEY) {
    warnings.push("SOLDCOMPS_API_KEY is not set; SoldComps image lookup will be skipped.");
  }
  if (!SERPAPI_API_KEY) {
    warnings.push("SERPAPI_API_KEY is not set; SerpAPI fallback image lookup will be skipped.");
  }

  const snapshots = loadPriceSnapshots(warnings);
  const localCandidates = findCandidates(snapshots, skipped);
  const refreshedCandidates = await refreshCurrentPrices(localCandidates.slice(0, REFRESH_LIMIT), warnings);
  const candidates = refreshedCandidates
    .filter((candidate) => passesMoveFilters(candidate))
    .sort(compareCandidates)
    .slice(0, Math.max(FEED_LIMIT * 3, FEED_LIMIT));

  const csvRows: string[][] = [CSV_COLUMNS.slice()];
  const selected: DebugSelected[] = [];

  for (const candidate of candidates) {
    if (selected.length >= FEED_LIMIT) {
      break;
    }

    const soldCompsListing = await findSoldCompsListing(candidate, warnings);
    let serpListing: Listing | undefined;
    let finalImageUrl = isUsableImageUrl(soldCompsListing?.imageUrl ?? "") ? soldCompsListing?.imageUrl ?? "" : "";

    if (!finalImageUrl) {
      serpListing = await findSerpApiListing(candidate, warnings);
      finalImageUrl = serpListing?.imageUrl ?? "";
    }

    if (!finalImageUrl) {
      skipped.push({
        cardName: candidate.cardName,
        cardNumber: candidate.cardNumber,
        grade: candidate.grade,
        reason: "No usable sold listing image found from SoldComps or SerpAPI.",
      });
      continue;
    }

    finalImageUrl = await maybeCacheImage(finalImageUrl, candidate, warnings);

    const displayName = formatCardDisplayName(candidate);
    const priceMove = `${formatMoney(candidate.priorPriceCents)} \u2192 ${formatMoney(candidate.currentPriceCents)}`;
    const percentMove = `+${Math.round(candidate.percentChange)}%`;

    csvRows.push([
      finalImageUrl,
      pickHook(candidate),
      displayName,
      priceMove,
      percentMove,
      "in the last 30 days",
    ]);

    selected.push({
      "card name": candidate.cardName,
      "card number": candidate.cardNumber,
      grade: candidate.grade,
      "old price": formatMoney(candidate.priorPriceCents),
      "new price": formatMoney(candidate.currentPriceCents),
      "percent change": percentMove,
      "SoldComps listing URL": soldCompsListing?.listingUrl ?? "",
      "SoldComps image URL if found": soldCompsListing?.imageUrl ?? "",
      "SerpAPI image URL if used": serpListing?.imageUrl ?? "",
      "final image URL": finalImageUrl,
      "reason the card was selected": [
        "Pokemon PSA 10 card",
        `current price ${formatMoney(candidate.currentPriceCents)} >= ${formatMoney(MIN_CURRENT_CENTS)}`,
        `prior price ${formatMoney(candidate.priorPriceCents)} >= ${formatMoney(MIN_PRIOR_CENTS)}`,
        `${percentMove} over ${LOOKBACK_DAYS} days`,
        `${formatMoney(candidate.absoluteGainCents)} absolute gain`,
        candidate.salesVolume ? `${candidate.salesVolume} yearly PriceCharting sales` : "PriceCharting snapshot match",
      ].join("; "),
    });
  }

  writeFileSync(OUTPUT_CSV, csvRows.map(toCsvLine).join("\n") + "\n");
  writeFileSync(
    OUTPUT_DEBUG,
    JSON.stringify(
      {
        generatedAt: startedAt,
        outputCsv: OUTPUT_CSV,
        snapshotPathsChecked: SNAPSHOT_PATHS.map((path) => resolvePath(path)),
        filters: {
          grade: "PSA 10",
          lookbackDays: LOOKBACK_DAYS,
          lookbackToleranceDays: LOOKBACK_TOLERANCE_DAYS,
          minCurrentPrice: formatMoney(MIN_CURRENT_CENTS),
          minPriorPrice: formatMoney(MIN_PRIOR_CENTS),
          minAbsoluteGain: formatMoney(MIN_GAIN_CENTS),
          minGainPercent: MIN_GAIN_PERCENT,
        },
        warnings,
        selected,
        skipped,
      },
      null,
      2,
    ) + "\n",
  );

  console.log(`Wrote ${OUTPUT_CSV}`);
  console.log(`Wrote ${OUTPUT_DEBUG}`);
  console.log(`Selected ${selected.length} cards.`);
  if (warnings.length) {
    console.warn(`Warnings:\n- ${warnings.join("\n- ")}`);
  }
}

function loadPriceSnapshots(warnings: string[]): PriceSnapshot[] {
  const files = SNAPSHOT_PATHS.flatMap((path) => collectSnapshotFiles(resolvePath(path)));
  const snapshots: PriceSnapshot[] = [];

  for (const file of unique(files)) {
    const ext = extname(file).toLowerCase();
    try {
      if (ext === ".json") {
        snapshots.push(...normalizeJsonSnapshots(file));
      } else if (ext === ".csv") {
        snapshots.push(...normalizeRows(parseCsv(readFileSync(file, "utf8")), file, dateFromPath(file)));
      }
    } catch (error) {
      warnings.push(`Could not read ${file}: ${errorMessage(error)}`);
    }
  }

  if (!snapshots.length) {
    warnings.push(
      "No local PriceCharting history/snapshot rows were found. PriceCharting only provides current prices, so the script cannot honestly compute 30-day gains without stored snapshots.",
    );
  }

  return snapshots;
}

function collectSnapshotFiles(path: string): string[] {
  if (!path || !existsSync(path)) {
    return [];
  }

  const stats = safeStat(path);
  if (!stats) {
    return [];
  }

  if (stats.isFile() && [".json", ".csv"].includes(extname(path).toLowerCase())) {
    return [path];
  }

  if (!stats.isDirectory()) {
    return [];
  }

  return readdirSync(path)
    .map((entry) => join(path, entry))
    .filter((entryPath) => {
      const entryStats = safeStat(entryPath);
      return Boolean(entryStats?.isFile() && [".json", ".csv"].includes(extname(entryPath).toLowerCase()));
    });
}

function normalizeJsonSnapshots(file: string): PriceSnapshot[] {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as JsonValue;
  const rowsWithDates = extractRowsWithDates(parsed, dateFromPath(file));
  return rowsWithDates.flatMap(({ rows, date }) => normalizeRows(rows, file, date));
}

function extractRowsWithDates(value: JsonValue, inheritedDate?: Date): Array<{ date?: Date; rows: Row[] }> {
  if (Array.isArray(value)) {
    return [{ date: inheritedDate, rows: value.filter(isObject) as Row[] }];
  }

  if (!isObject(value)) {
    return [];
  }

  const object = value as Record<string, JsonValue>;
  const objectDate = parseDate(firstString(object, ["date", "snapshotDate", "snapshot_date", "createdAt", "created_at"])) ?? inheritedDate;
  const directRows = firstArray(object, ["rows", "products", "items", "data", "prices", "snapshots"]);

  if (directRows) {
    return [{ date: objectDate, rows: directRows.filter(isObject) as Row[] }];
  }

  return Object.entries(object).flatMap(([key, child]) => {
    const childDate = parseDate(key) ?? objectDate;
    return extractRowsWithDates(child, childDate);
  });
}

function normalizeRows(rows: Row[], file: string, fileDate?: Date): PriceSnapshot[] {
  const snapshots: PriceSnapshot[] = [];

  for (const row of rows) {
    const date = parseDate(firstString(row, ["date", "snapshotDate", "snapshot_date", "createdAt", "created_at"])) ?? fileDate;
    const productId = firstString(row, ["id", "product-id", "productId", "pricechartingId", "pricecharting_id"]);
    const productName = firstString(row, ["product-name", "productName", "name", "title", "cardName", "card_name"]);
    const consoleName = firstString(row, ["console-name", "consoleName", "set", "setName", "category"]) ?? "";
    const genre = firstString(row, ["genre", "category", "type"]) ?? "";
    const priceCents = firstPriceCents(row, [
      "manual-only-price",
      "psa-10-price",
      "psa10-price",
      "psa_10_price",
      "grade-10-price",
      "graded-10-price",
      "pricePsa10",
      "psa10",
    ]);

    if (!date || !productId || !productName || priceCents === undefined || priceCents <= 0) {
      continue;
    }

    const cardNumber = extractCardNumber(row, productName);

    snapshots.push({
      cardName: cleanCardName(productName),
      cardNumber,
      consoleName,
      date,
      genre,
      grade: "PSA 10",
      priceCents,
      productId,
      salesVolume: parseInteger(firstValue(row, ["sales-volume", "salesVolume", "volume"])) ?? 0,
      sourceFile: file,
    });
  }

  return snapshots;
}

function findCandidates(snapshots: PriceSnapshot[], skipped: Array<Record<string, unknown>>): Candidate[] {
  const byProduct = groupBy(snapshots.filter(isPokemonCardSnapshot), (snapshot) => snapshot.productId);
  const candidates: Candidate[] = [];

  for (const [productId, productSnapshots] of byProduct) {
    const ordered = productSnapshots.slice().sort((a, b) => a.date.getTime() - b.date.getTime());
    const current = ordered[ordered.length - 1];
    const prior = pickPriorSnapshot(ordered, current.date);

    if (!prior) {
      skipped.push({
        productId,
        cardName: current.cardName,
        reason: `No local snapshot close enough to ${LOOKBACK_DAYS} days before ${toDateKey(current.date)}.`,
      });
      continue;
    }

    const candidate = buildCandidate(current, prior);

    if (!passesMoveFilters(candidate)) {
      skipped.push({
        productId,
        cardName: candidate.cardName,
        currentPrice: formatMoney(candidate.currentPriceCents),
        priorPrice: formatMoney(candidate.priorPriceCents),
        percentChange: `${Math.round(candidate.percentChange)}%`,
        reason: "Did not pass minimum current/prior price, percent gain, or dollar gain filters.",
      });
      continue;
    }

    candidates.push(candidate);
  }

  return candidates.sort(compareCandidates);
}

function pickPriorSnapshot(snapshots: PriceSnapshot[], currentDate: Date): PriceSnapshot | undefined {
  const targetTime = currentDate.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const toleranceMs = LOOKBACK_TOLERANCE_DAYS * 24 * 60 * 60 * 1000;

  return snapshots
    .filter((snapshot) => snapshot.date.getTime() < currentDate.getTime())
    .map((snapshot) => ({ snapshot, distance: Math.abs(snapshot.date.getTime() - targetTime) }))
    .filter(({ distance }) => distance <= toleranceMs)
    .sort((a, b) => a.distance - b.distance)[0]?.snapshot;
}

function buildCandidate(current: PriceSnapshot, prior: PriceSnapshot): Candidate {
  const absoluteGainCents = current.priceCents - prior.priceCents;

  return {
    absoluteGainCents,
    cardName: current.cardName,
    cardNumber: current.cardNumber,
    consoleName: current.consoleName,
    current,
    currentPriceCents: current.priceCents,
    grade: current.grade,
    percentChange: (absoluteGainCents / prior.priceCents) * 100,
    prior,
    priorPriceCents: prior.priceCents,
    productId: current.productId,
    salesVolume: current.salesVolume,
  };
}

async function refreshCurrentPrices(candidates: Candidate[], warnings: string[]): Promise<Candidate[]> {
  if (!PRICECHARTING_TOKEN || !candidates.length) {
    return candidates;
  }

  const refreshed: Candidate[] = [];

  for (const candidate of candidates) {
    try {
      const product = await priceChartingProduct(candidate.productId);
      const currentPriceCents = firstPriceCents(product, ["manual-only-price", "psa-10-price", "psa10-price"]);

      if (!currentPriceCents) {
        refreshed.push(candidate);
        continue;
      }

      const current = {
        ...candidate.current,
        priceCents: currentPriceCents,
        salesVolume: parseInteger(firstValue(product, ["sales-volume", "salesVolume"])) ?? candidate.salesVolume,
      };
      refreshed.push(buildCandidate(current, candidate.prior));
    } catch (error) {
      warnings.push(`Could not refresh PriceCharting product ${candidate.productId}: ${errorMessage(error)}`);
      refreshed.push(candidate);
    }

    await delay(1100);
  }

  return refreshed;
}

async function priceChartingProduct(productId: string): Promise<Row> {
  const url = new URL("https://www.pricecharting.com/api/product");
  url.searchParams.set("t", PRICECHARTING_TOKEN ?? "");
  url.searchParams.set("id", productId);

  const json = await fetchJson(url, {});
  if (isObject(json) && json.status === "error") {
    throw new Error(String(json["error-message"] ?? "PriceCharting API error"));
  }

  return json as Row;
}

async function findSoldCompsListing(candidate: Candidate, warnings: string[]): Promise<Listing | undefined> {
  if (!SOLDCOMPS_API_KEY) {
    return undefined;
  }

  const query = listingSearchQuery(candidate);
  const url = new URL(SOLDCOMPS_API_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("query", query);
  url.searchParams.set("limit", "20");
  url.searchParams.set("sold", "true");

  try {
    const json = await fetchJson(url, {
      Authorization: `Bearer ${SOLDCOMPS_API_KEY}`,
      "X-API-Key": SOLDCOMPS_API_KEY,
      Accept: "application/json",
    });
    return pickBestListing(extractListings(json, "SoldComps"), candidate, false);
  } catch (error) {
    warnings.push(`SoldComps lookup failed for ${formatCardDisplayName(candidate)}: ${errorMessage(error)}`);
    return undefined;
  }
}

async function findSerpApiListing(candidate: Candidate, warnings: string[]): Promise<Listing | undefined> {
  if (!SERPAPI_API_KEY) {
    return undefined;
  }

  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "ebay");
  url.searchParams.set("api_key", SERPAPI_API_KEY);
  url.searchParams.set("ebay_domain", "ebay.com");
  url.searchParams.set("show_only", "Sold");
  url.searchParams.set("_ipg", "25");
  url.searchParams.set("_nkw", listingSearchQuery(candidate));

  try {
    const json = await fetchJson(url, { Accept: "application/json" });
    return pickBestListing(extractListings(json, "SerpAPI"), candidate, true);
  } catch (error) {
    warnings.push(`SerpAPI lookup failed for ${formatCardDisplayName(candidate)}: ${errorMessage(error)}`);
    return undefined;
  }
}

function extractListings(json: unknown, source: Listing["source"]): Listing[] {
  const rows = firstArrayDeep(json, ["results", "items", "listings", "data", "organic_results"]) ?? [];

  return rows.filter(isObject).map((row) => {
    const imageUrl = firstString(row, [
      "image",
      "imageUrl",
      "image_url",
      "thumbnail",
      "galleryURL",
      "pictureURL",
      "picture_url",
      "mainImage",
      "main_image",
    ]);
    const imageFromNested = imageUrl ?? firstString(firstArray(row, ["images", "photos", "pictures"])?.find(isObject) as Row | undefined, [
      "url",
      "imageUrl",
      "image_url",
    ]);

    return {
      imageUrl: upgradeEbayImage(imageFromNested ?? ""),
      listingUrl:
        firstString(row, ["url", "link", "itemUrl", "item_url", "listingUrl", "listing_url", "viewItemURL"]) ?? "",
      price: parseDollarAmount(firstValue(row, ["price", "soldPrice", "sold_price", "amount"])),
      soldDate: firstString(row, ["soldDate", "sold_date", "dateSold", "date_sold", "endDate", "endedAt", "ended_at"]),
      source,
      title: firstString(row, ["title", "name", "itemTitle", "item_title"]) ?? "",
    };
  });
}

function pickBestListing(listings: Listing[], candidate: Candidate, requireImage: boolean): Listing | undefined {
  return listings
    .filter((listing) => !requireImage || isUsableImageUrl(listing.imageUrl))
    .filter((listing) => isAllowedListingTitle(listing.title))
    .filter((listing) => listingMatchesCandidate(listing, candidate))
    .sort((a, b) => scoreListing(b, candidate) - scoreListing(a, candidate))[0];
}

function listingMatchesCandidate(listing: Listing, candidate: Candidate): boolean {
  const text = normalizeSearchText(`${listing.title} ${listing.listingUrl}`);
  const cardWords = normalizeSearchText(candidate.cardName)
    .split(" ")
    .filter((word) => word.length >= 4);
  const matchingWords = cardWords.filter((word) => text.includes(word)).length;
  const normalizedCardNumber = normalizeSearchText(candidate.cardNumber);
  const bareCardNumber = normalizedCardNumber.replace(/^#/, "");
  const hasNumber = !candidate.cardNumber || text.includes(normalizedCardNumber) || text.includes(bareCardNumber);

  return text.includes("psa") && text.includes("10") && hasNumber && matchingWords >= Math.min(2, cardWords.length);
}

function scoreListing(listing: Listing, candidate: Candidate): number {
  const text = normalizeSearchText(listing.title);
  let score = 0;

  if (listing.listingUrl.includes("ebay.")) score += 20;
  if (text.includes("psa 10") || text.includes("psa10")) score += 20;
  if (isUsableImageUrl(listing.imageUrl)) score += 15;
  if (text.includes("slab") || text.includes("graded")) score += 10;
  if (candidate.cardNumber && text.includes(normalizeSearchText(candidate.cardNumber).replace(/^#/, ""))) score += 10;
  if (listing.soldDate) score += 5;
  if (listing.price && listing.price >= candidate.currentPriceCents / 100 * 0.6) score += 5;

  return score;
}

async function maybeCacheImage(imageUrl: string, candidate: Candidate, warnings: string[]): Promise<string> {
  if (!PUBLIC_ASSET_DIR || !PUBLIC_BASE_URL) {
    return imageUrl;
  }

  const assetDir = resolvePath(PUBLIC_ASSET_DIR);
  if (!existsSync(assetDir)) {
    warnings.push(`PUBLIC_ASSET_DIR does not exist (${assetDir}); using source image URLs.`);
    return imageUrl;
  }

  try {
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    const extension = contentType.includes("png") ? "png" : "jpg";
    const fileName = `${slugify(candidate.cardName)}-${candidate.cardNumber || candidate.productId}-${candidate.grade.toLowerCase().replace(/\s+/g, "-")}.${extension}`;
    const targetPath = join(assetDir, fileName);
    const buffer = Buffer.from(await response.arrayBuffer());

    mkdirSync(assetDir, { recursive: true });
    writeFileSync(targetPath, buffer);

    return `${PUBLIC_BASE_URL}/${fileName}`;
  } catch (error) {
    warnings.push(`Could not cache image for ${formatCardDisplayName(candidate)}: ${errorMessage(error)}`);
    return imageUrl;
  }
}

function passesMoveFilters(candidate: Candidate): boolean {
  return (
    candidate.currentPriceCents >= MIN_CURRENT_CENTS &&
    candidate.priorPriceCents >= MIN_PRIOR_CENTS &&
    candidate.absoluteGainCents >= MIN_GAIN_CENTS &&
    candidate.percentChange >= MIN_GAIN_PERCENT
  );
}

function compareCandidates(a: Candidate, b: Candidate): number {
  return b.salesVolume - a.salesVolume || b.absoluteGainCents - a.absoluteGainCents || b.percentChange - a.percentChange;
}

function isPokemonCardSnapshot(snapshot: PriceSnapshot): boolean {
  const haystack = normalizeSearchText(`${snapshot.cardName} ${snapshot.consoleName} ${snapshot.genre}`);
  return haystack.includes("pokemon") && !hasExcludedTerm(haystack);
}

function isAllowedListingTitle(title: string): boolean {
  const normalized = ` ${normalizeSearchText(title)} `;
  return !EXCLUDED_LISTING_TERMS.some((term) => normalized.includes(term));
}

function hasExcludedTerm(text: string): boolean {
  const normalized = ` ${normalizeSearchText(text)} `;
  return EXCLUDED_LISTING_TERMS.some((term) => normalized.includes(term));
}

function listingSearchQuery(candidate: Candidate): string {
  return [candidate.cardName, candidate.cardNumber, "Pokemon", "PSA 10"].filter(Boolean).join(" ");
}

function formatCardDisplayName(candidate: Candidate): string {
  return [candidate.cardName, candidate.cardNumber].filter(Boolean).join(" ") + ` \u2022 ${candidate.grade}`;
}

function pickHook(candidate: Candidate): string {
  if (candidate.percentChange >= 75) return "THIS CARD WENT PARABOLIC";
  if (candidate.absoluteGainCents >= dollarsToCents(1000)) return "THIS SLAB JUST SURGED";
  return "THIS CARD JUST EXPLODED";
}

function extractCardNumber(row: Row, productName: string): string {
  const explicit = firstString(row, ["cardNumber", "card_number", "number", "card-no", "card_no"]);
  if (explicit) return explicit.startsWith("#") ? explicit : `#${explicit}`;

  const match = productName.match(/#\s*([A-Za-z0-9-]+)/);
  return match ? `#${match[1]}` : "";
}

function cleanCardName(productName: string): string {
  return productName.replace(/\s+#\s*[A-Za-z0-9-]+.*$/, "").replace(/\s+/g, " ").trim();
}

function parseCsv(text: string): Row[] {
  const rows: string[][] = [];
  let current = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(current);
      current = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(current);
      if (row.some((cell) => cell.trim() !== "")) rows.push(row);
      row = [];
      current = "";
      continue;
    }

    current += char;
  }

  row.push(current);
  if (row.some((cell) => cell.trim() !== "")) rows.push(row);

  const [headers, ...dataRows] = rows;
  if (!headers) return [];

  return dataRows.map((dataRow) =>
    Object.fromEntries(headers.map((header, index) => [header.trim(), dataRow[index]?.trim() ?? ""])),
  );
}

function toCsvLine(values: readonly string[]): string {
  return values
    .map((value) => {
      const safeValue = value ?? "";
      return /[",\n\r]/.test(safeValue) ? `"${safeValue.replace(/"/g, '""')}"` : safeValue;
    })
    .join(",");
}

async function fetchJson(url: URL, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url.hostname}`);
  }
  return response.json();
}

function firstArrayDeep(value: unknown, keys: string[]): unknown[] | undefined {
  if (Array.isArray(value)) {
    return value;
  }

  if (!isObject(value)) {
    return undefined;
  }

  for (const key of keys) {
    const found = firstArray(value, [key]);
    if (found) return found;
  }

  for (const child of Object.values(value)) {
    const found = firstArrayDeep(child, keys);
    if (found) return found;
  }

  return undefined;
}

function firstArray(row: Row | undefined, keys: string[]): unknown[] | undefined {
  if (!row) return undefined;
  for (const key of keys) {
    const value = getCaseInsensitive(row, key);
    if (Array.isArray(value)) return value;
  }
  return undefined;
}

function firstString(row: Row | undefined, keys: string[]): string | undefined {
  if (!row) return undefined;
  for (const key of keys) {
    const value = getCaseInsensitive(row, key);
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function firstValue(row: Row | undefined, keys: string[]): unknown {
  if (!row) return undefined;
  for (const key of keys) {
    const value = getCaseInsensitive(row, key);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function firstPriceCents(row: Row, keys: string[]): number | undefined {
  for (const key of keys) {
    const cents = parsePriceCents(getCaseInsensitive(row, key));
    if (cents !== undefined) return cents;
  }
  return undefined;
}

function getCaseInsensitive(row: Row, key: string): unknown {
  if (Object.prototype.hasOwnProperty.call(row, key)) return row[key];
  const wanted = key.toLowerCase();
  const foundKey = Object.keys(row).find((candidate) => candidate.toLowerCase() === wanted);
  return foundKey ? row[foundKey] : undefined;
}

function parsePriceCents(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value);
  }

  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  const trimmed = value.trim();
  const numeric = Number(trimmed.replace(/[$,]/g, ""));
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return undefined;
  }

  return trimmed.includes(".") || trimmed.includes("$") ? Math.round(numeric * 100) : Math.round(numeric);
}

function parseDollarAmount(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[$,]/g, "").match(/\d+(?:\.\d+)?/)?.[0]);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (isObject(value)) {
    return parseDollarAmount(value["extracted"] ?? value["raw"]);
  }
  return undefined;
}

function parseInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, ""));
    return Number.isFinite(parsed) ? Math.round(parsed) : undefined;
  }
  return undefined;
}

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  const normalized = value.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? value.match(/\d{4}\d{2}\d{2}/)?.[0];
  if (!normalized) {
    return undefined;
  }

  const isoDate =
    normalized.length === 8
      ? `${normalized.slice(0, 4)}-${normalized.slice(4, 6)}-${normalized.slice(6, 8)}`
      : normalized;
  const date = new Date(`${isoDate}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function dateFromPath(path: string): Date | undefined {
  return parseDate(path);
}

function formatMoney(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(cents / 100);
}

function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100);
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9#]+/g, " ").replace(/\s+/g, " ").trim();
}

function isUsableImageUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) && !/spacer|placeholder|transparent|1x1|\.gif(?:$|\?)/i.test(value);
}

function upgradeEbayImage(value: string): string {
  return value.replace(/\/s-l\d+\.(jpg|jpeg|png|webp)/i, "/s-l1600.$1");
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug || createHash("sha1").update(value).digest("hex").slice(0, 10);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function resolvePath(path: string): string {
  return isAbsolute(path) ? path : resolve(ROOT, path);
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function groupBy<T>(values: T[], keyFn: (value: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const value of values) {
    const key = keyFn(value);
    map.set(key, [...(map.get(key) ?? []), value]);
  }
  return map;
}

function isObject(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeStat(path: string) {
  try {
    return existsSync(path) ? statSync(path) : undefined;
  } catch {
    return undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
