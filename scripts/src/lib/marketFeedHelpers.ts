import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type Row = Record<string, unknown>;

export type PriceSnapshot = {
  cardName: string;
  cardNumber: string;
  consoleName: string;
  date: Date;
  genre: string;
  grade: "PSA 10";
  priceCents: number;
  productId: string;
  salesVolume: number;
  source: string;
};

export type TargetCard = {
  cardName: string;
  cardNumber: string;
  displayName: string;
  productId?: string;
};

export type Listing = {
  imageUrl: string;
  listingUrl: string;
  priceCents?: number;
  soldAt?: Date;
  source: "SoldComps" | "SerpAPI";
  title: string;
};

export type PriceMove = {
  currentPriceCents: number;
  priorPriceCents: number;
  percentChange: number;
  source: string;
  currentAsOf?: string;
  priorAsOf?: string;
};

export const CSV_COLUMNS = ["Image-JZ4", "Text-99R", "Text-D72", "Text-PLR", "Text-BJJ", "Text-2ZV"] as const;

export const EXCLUDED_LISTING_TERMS = [
  " lot ",
  " lots ",
  "bundle",
  "proxy",
  "custom",
  "digital",
  "reprint",
  "damaged",
  "empty slab",
  "case only",
  "label only",
  "mystery",
  "choose your card",
  "orica",
  "fan art",
  "gold metal",
  "pack",
  "booster",
  "sealed",
  "replica",
];

export function resolveApiEnv(): {
  priceChartingToken: string;
  soldCompsApiKey: string;
  serpApiKey: string;
  soldCompsApiUrl: string;
} {
  return {
    priceChartingToken:
      process.env.PRICECHARTING_API_TOKEN?.trim() ||
      process.env.pricecharting_API_key?.trim() ||
      process.env.PRICECHARTING_API_KEY?.trim() ||
      "",
    soldCompsApiKey: process.env.SOLDCOMPS_API_KEY?.trim() ?? "",
    serpApiKey: process.env.SERPAPI_API_KEY?.trim() ?? "",
    soldCompsApiUrl: process.env.SOLDCOMPS_API_URL?.trim() || "https://api.soldcomps.com/v1/search",
  };
}

export function defaultSnapshotPaths(root: string): string[] {
  return [
    process.env.PRICECHARTING_HISTORY_PATH,
    process.env.SLABFOLIO_PRICE_SNAPSHOT_PATH,
    "data/pricecharting-snapshots",
    "data/price-snapshots",
    "data/pricecharting-history.json",
    "data/pricecharting-history.csv",
  ]
    .filter(Boolean)
    .map((path) => resolvePath(root, path as string));
}

export function loadStoredSnapshots(paths: string[], warnings: string[]): PriceSnapshot[] {
  const files = paths.flatMap((path) => collectSnapshotFiles(path));
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

  return snapshots;
}

export async function resolveProductId(
  card: TargetCard,
  snapshots: PriceSnapshot[],
  priceChartingToken: string,
  warnings: string[],
): Promise<string | undefined> {
  if (card.productId) {
    return card.productId;
  }

  const match = snapshots.find(
    (snapshot) =>
      cardNumbersMatch(snapshot.cardNumber, card.cardNumber) &&
      normalizeSearchText(snapshot.cardName).includes(normalizeSearchText(card.cardName).split(" ")[0]),
  );
  if (match) {
    return match.productId;
  }

  if (!priceChartingToken) {
    return undefined;
  }

  const query = [card.cardName, card.cardNumber.replace(/^#/, "")].filter(Boolean).join(" ");
  try {
    const url = new URL("https://www.pricecharting.com/api/products");
    url.searchParams.set("t", priceChartingToken);
    url.searchParams.set("q", query);
    const json = await fetchJson(url, {});
    const products = firstArrayDeep(json, ["products"])?.filter(isObject) as Row[] | undefined;
    const best = (products ?? [])
      .map((product) => ({ product, score: scorePriceChartingProduct(product, card) }))
      .sort((a, b) => b.score - a.score)[0];
    if (best && best.score >= 12) {
      return firstString(best.product, ["id", "product-id", "productId"]);
    }
    warnings.push(`PriceCharting search did not confidently match ${card.displayName}.`);
  } catch (error) {
    warnings.push(`PriceCharting search failed for ${card.displayName}: ${errorMessage(error)}`);
  }

  return undefined;
}

export async function fetchPriceChartingPsa10Cents(productId: string, token: string): Promise<number | undefined> {
  const product = await priceChartingProduct(productId, token);
  return firstPriceCents(product, ["manual-only-price", "psa-10-price", "psa10-price"]);
}

export async function computePriceMove(
  card: TargetCard,
  productId: string | undefined,
  snapshots: PriceSnapshot[],
  env: ReturnType<typeof resolveApiEnv>,
  warnings: string[],
): Promise<PriceMove | undefined> {
  const productSnapshots = productId
    ? snapshots.filter((snapshot) => snapshot.productId === productId).sort((a, b) => a.date.getTime() - b.date.getTime())
    : snapshots.filter((snapshot) => matchesTargetCard(snapshot, card)).sort((a, b) => a.date.getTime() - b.date.getTime());

  const snapshotMove = await refreshSnapshotMoveCurrent(productSnapshots, productId, env.priceChartingToken);
  if (snapshotMove) {
    return snapshotMove;
  }

  const soldCompMove = await buildSoldCompPriceMove(card, env, warnings);
  if (soldCompMove) {
    return soldCompMove;
  }

  if (!productId || !env.priceChartingToken) {
    return undefined;
  }

  const currentFromApi = await fetchPriceChartingPsa10Cents(productId, env.priceChartingToken);
  const priorSnapshot = pickSnapshotNearDaysAgo(productSnapshots, 30, 14);
  if (currentFromApi && priorSnapshot) {
    return buildPriceMove(currentFromApi, priorSnapshot.priceCents, "PriceCharting current + stored snapshot prior", {
      currentAsOf: "PriceCharting API (manual-only-price)",
      priorAsOf: priorSnapshot.date.toISOString().slice(0, 10),
    });
  }

  if (currentFromApi && productSnapshots.length >= 2) {
    const prior = productSnapshots[0];
    if (prior.date.getTime() < productSnapshots[productSnapshots.length - 1].date.getTime()) {
      return buildPriceMove(
        currentFromApi,
        prior.priceCents,
        "PriceCharting current + oldest stored snapshot prior",
        { currentAsOf: "PriceCharting API (manual-only-price)", priorAsOf: prior.date.toISOString().slice(0, 10) },
      );
    }
  }

  warnings.push(`Could not compute an honest 30-day price move for ${card.displayName}.`);
  return undefined;
}

async function refreshSnapshotMoveCurrent(
  productSnapshots: PriceSnapshot[],
  productId: string | undefined,
  priceChartingToken: string,
): Promise<PriceMove | undefined> {
  const snapshotMove = buildSnapshotPriceMove(productSnapshots);
  if (!snapshotMove || !productId || !priceChartingToken) {
    return snapshotMove;
  }

  const currentFromApi = await fetchPriceChartingPsa10Cents(productId, priceChartingToken);
  if (!currentFromApi) {
    return snapshotMove;
  }

  return buildPriceMove(
    currentFromApi,
    snapshotMove.priorPriceCents,
    `${snapshotMove.source} prior + PriceCharting current`,
    { currentAsOf: "PriceCharting API (manual-only-price)", priorAsOf: snapshotMove.priorAsOf },
  );
}

function buildSnapshotPriceMove(productSnapshots: PriceSnapshot[]): PriceMove | undefined {
  if (productSnapshots.length < 2) {
    return undefined;
  }

  const current = productSnapshots[productSnapshots.length - 1];
  const prior = pickSnapshotNearDaysAgo(productSnapshots, 30, 14);
  if (!prior || prior.date.getTime() >= current.date.getTime()) {
    return undefined;
  }

  return buildPriceMove(current.priceCents, prior.priceCents, "Stored price snapshots", {
    currentAsOf: current.date.toISOString().slice(0, 10),
    priorAsOf: prior.date.toISOString().slice(0, 10),
  });
}

async function buildSoldCompPriceMove(
  card: TargetCard,
  env: ReturnType<typeof resolveApiEnv>,
  warnings: string[],
): Promise<PriceMove | undefined> {
  if (!env.soldCompsApiKey) {
    return undefined;
  }

  const listings = await searchSoldCompsListings(card, env, warnings);
  if (!listings.length) {
    return undefined;
  }

  const now = Date.now();
  const currentListings = listings.filter((listing) => {
    if (!listing.soldAt) return true;
    const ageDays = (now - listing.soldAt.getTime()) / (24 * 60 * 60 * 1000);
    return ageDays <= 21;
  });
  const priorListings = listings.filter((listing) => {
    if (!listing.soldAt) return false;
    const ageDays = (now - listing.soldAt.getTime()) / (24 * 60 * 60 * 1000);
    return ageDays >= 25 && ageDays <= 45;
  });

  const currentMedian = medianCents(currentListings.map((listing) => listing.priceCents).filter(isFiniteNumber));
  const priorMedian = medianCents(priorListings.map((listing) => listing.priceCents).filter(isFiniteNumber));

  if (currentMedian && priorMedian) {
    return buildPriceMove(currentMedian, priorMedian, "SoldComps sold listing medians", {
      currentAsOf: "recent sold comps",
      priorAsOf: "25-45 day sold comps",
    });
  }

  return undefined;
}

export async function findBestListingImage(
  card: TargetCard,
  productId: string | undefined,
  env: ReturnType<typeof resolveApiEnv>,
  warnings: string[],
): Promise<{ listing?: Listing; imageUrl: string; imageSource: string }> {
  const soldCompsListing = await findSoldCompsListing(card, env, warnings);
  if (soldCompsListing?.imageUrl) {
    return { listing: soldCompsListing, imageUrl: soldCompsListing.imageUrl, imageSource: "SoldComps" };
  }

  const serpListing = await findSerpApiListing(card, env, warnings);
  if (serpListing?.imageUrl) {
    return { listing: serpListing, imageUrl: serpListing.imageUrl, imageSource: "SerpAPI" };
  }

  return { imageUrl: "", imageSource: "none" };
}

export async function maybeCachePublicImage(
  imageUrl: string,
  card: TargetCard,
  warnings: string[],
): Promise<string> {
  const assetDir = process.env.PUBLIC_ASSET_DIR;
  const baseUrl = trimTrailingSlash(process.env.PUBLIC_BASE_URL ?? "");
  if (!assetDir || !baseUrl) {
    return imageUrl;
  }

  const resolvedDir = resolvePath(process.cwd(), assetDir);
  if (!existsSync(resolvedDir)) {
    warnings.push(`PUBLIC_ASSET_DIR does not exist (${resolvedDir}); using external image URL.`);
    return imageUrl;
  }

  try {
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    const extension = contentType.includes("png") ? "png" : "jpg";
    const fileName = `${slugify(card.cardName)}-${card.cardNumber.replace(/^#/, "")}-psa-10.${extension}`;
    const targetPath = join(resolvedDir, fileName);
    mkdirSync(resolvedDir, { recursive: true });
    writeFileSync(targetPath, Buffer.from(await response.arrayBuffer()));
    return `${baseUrl}/${fileName}`;
  } catch (error) {
    warnings.push(`Could not cache image for ${card.displayName}: ${errorMessage(error)}`);
    return imageUrl;
  }
}

export function parseFeedCsv(text: string): Array<Record<(typeof CSV_COLUMNS)[number], string>> {
  const rows = parseCsv(text);
  return rows.map((row) => ({
    "Image-JZ4": String(row["Image-JZ4"] ?? ""),
    "Text-99R": String(row["Text-99R"] ?? ""),
    "Text-D72": String(row["Text-D72"] ?? ""),
    "Text-PLR": String(row["Text-PLR"] ?? ""),
    "Text-BJJ": String(row["Text-BJJ"] ?? ""),
    "Text-2ZV": String(row["Text-2ZV"] ?? ""),
  }));
}

export function toCsvLine(values: readonly string[]): string {
  return values
    .map((value) => {
      const safeValue = value ?? "";
      return /[",\n\r]/.test(safeValue) ? `"${safeValue.replace(/"/g, '""')}"` : safeValue;
    })
    .join(",");
}

export function formatMoney(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(cents / 100);
}

export function formatPercentChange(percentChange: number): string {
  const rounded = Math.round(percentChange);
  return `${rounded >= 0 ? "+" : ""}${rounded}%`;
}

export function formatPriceMoveText(move: PriceMove): string {
  return `${formatMoney(move.priorPriceCents)} \u2192 ${formatMoney(move.currentPriceCents)}`;
}

export function isMissingCell(value: string): boolean {
  const trimmed = value.trim();
  return !trimmed || trimmed === "-" || trimmed.toLowerCase() === "tbd";
}

export function matchesFeedRow(card: TargetCard, rowDisplayName: string): boolean {
  const normalizedRow = normalizeSearchText(rowDisplayName);
  const normalizedCard = normalizeSearchText(card.displayName.replace(/\s*•\s*PSA\s*10/i, ""));
  const bareNumber = card.cardNumber.replace(/^#/, "");
  return (
    normalizedRow.includes(normalizeSearchText(card.cardName)) &&
    (normalizedRow.includes(normalizeSearchText(card.cardNumber)) || normalizedRow.includes(bareNumber) || normalizedCard === normalizedRow)
  );
}

function buildPriceMove(
  currentPriceCents: number,
  priorPriceCents: number,
  source: string,
  meta: { currentAsOf?: string; priorAsOf?: string },
): PriceMove {
  return {
    currentPriceCents,
    priorPriceCents,
    percentChange: ((currentPriceCents - priorPriceCents) / priorPriceCents) * 100,
    source,
    ...meta,
  };
}

function pickSnapshotNearDaysAgo(snapshots: PriceSnapshot[], days: number, toleranceDays: number): PriceSnapshot | undefined {
  if (!snapshots.length) return undefined;
  const current = snapshots[snapshots.length - 1];
  const targetTime = current.date.getTime() - days * 24 * 60 * 60 * 1000;
  const toleranceMs = toleranceDays * 24 * 60 * 60 * 1000;

  return snapshots
    .filter((snapshot) => snapshot.date.getTime() < current.date.getTime())
    .map((snapshot) => ({ snapshot, distance: Math.abs(snapshot.date.getTime() - targetTime) }))
    .filter(({ distance }) => distance <= toleranceMs)
    .sort((a, b) => a.distance - b.distance)[0]?.snapshot;
}

function matchesTargetCard(snapshot: PriceSnapshot, card: TargetCard): boolean {
  return (
    cardNumbersMatch(snapshot.cardNumber, card.cardNumber) &&
    normalizeSearchText(snapshot.cardName).includes(normalizeSearchText(card.cardName).split(" ")[0])
  );
}

function cardNumbersMatch(a: string, b: string): boolean {
  const normalize = (value: string) => value.replace(/^#/, "").replace(/^0+/, "") || "0";
  return normalize(a) === normalize(b);
}

function scorePriceChartingProduct(product: Row, card: TargetCard): number {
  const name = normalizeSearchText(firstString(product, ["product-name", "productName", "name"]) ?? "");
  const cardName = normalizeSearchText(card.cardName);
  const cardNumber = card.cardNumber.replace(/^#/, "");
  let score = 0;
  if (name.includes(cardName)) score += 10;
  if (cardNumber && name.includes(cardNumber)) score += 10;
  if (name.includes("pokemon")) score += 2;
  return score;
}

async function priceChartingProduct(productId: string, token: string): Promise<Row> {
  const url = new URL("https://www.pricecharting.com/api/product");
  url.searchParams.set("t", token);
  url.searchParams.set("id", productId);
  const json = await fetchJson(url, {});
  if (isObject(json) && json.status === "error") {
    throw new Error(String(json["error-message"] ?? "PriceCharting API error"));
  }
  return json as Row;
}

async function searchSoldCompsListings(
  card: TargetCard,
  env: ReturnType<typeof resolveApiEnv>,
  warnings: string[],
): Promise<Listing[]> {
  if (!env.soldCompsApiKey) {
    return [];
  }

  const query = listingSearchQuery(card);
  const url = new URL(env.soldCompsApiUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("query", query);
  url.searchParams.set("limit", "40");
  url.searchParams.set("sold", "true");

  try {
    const json = await fetchJson(url, {
      Authorization: `Bearer ${env.soldCompsApiKey}`,
      "X-API-Key": env.soldCompsApiKey,
      Accept: "application/json",
    });
    return extractListings(json, "SoldComps").filter((listing) => listingMatchesCard(listing, card));
  } catch (error) {
    warnings.push(`SoldComps lookup failed for ${card.displayName}: ${errorMessage(error)}`);
    return [];
  }
}

async function findSoldCompsListing(
  card: TargetCard,
  env: ReturnType<typeof resolveApiEnv>,
  warnings: string[],
): Promise<Listing | undefined> {
  const listings = await searchSoldCompsListings(card, env, warnings);
  return pickBestListing(listings, card, false);
}

async function findSerpApiListing(
  card: TargetCard,
  env: ReturnType<typeof resolveApiEnv>,
  warnings: string[],
): Promise<Listing | undefined> {
  if (!env.serpApiKey) {
    return undefined;
  }

  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "ebay");
  url.searchParams.set("api_key", env.serpApiKey);
  url.searchParams.set("ebay_domain", "ebay.com");
  url.searchParams.set("show_only", "Sold");
  url.searchParams.set("_ipg", "25");
  url.searchParams.set("_nkw", listingSearchQuery(card));

  try {
    const json = await fetchJson(url, { Accept: "application/json" });
    return pickBestListing(extractListings(json, "SerpAPI"), card, true);
  } catch (error) {
    warnings.push(`SerpAPI lookup failed for ${card.displayName}: ${errorMessage(error)}`);
    return undefined;
  }
}

function extractListings(json: unknown, source: Listing["source"]): Listing[] {
  const rows = firstArrayDeep(json, ["results", "items", "listings", "data", "organic_results"]) ?? [];

  return rows.filter(isObject).map((row) => {
    const imageUrl = extractListingImage(row);
    const soldDate = firstString(row, ["soldDate", "sold_date", "dateSold", "date_sold", "endDate", "endedAt", "ended_at", "date"]);
    const priceRaw = firstValue(row, ["price", "soldPrice", "sold_price", "amount", "sold_price_cents"]);

    return {
      imageUrl: upgradeEbayImage(imageUrl),
      listingUrl: firstString(row, ["url", "link", "itemUrl", "item_url", "listingUrl", "listing_url", "viewItemURL"]) ?? "",
      priceCents: parseListingPriceCents(priceRaw),
      soldAt: parseDate(soldDate),
      source,
      title: firstString(row, ["title", "name", "itemTitle", "item_title"]) ?? "",
    };
  });
}

function extractListingImage(row: Row): string {
  const direct = firstString(row, [
    "imageUrl",
    "image",
    "thumbnail",
    "thumbnailUrl",
    "galleryURL",
    "pictureUrl",
    "image_url",
    "thumbnail_url",
    "picture_url",
    "mainImage",
    "main_image",
  ]);
  if (direct) {
    return direct;
  }

  const images = firstArray(row, ["images", "photos", "pictures"]);
  if (images?.length) {
    const first = images[0];
    if (typeof first === "string" && first.trim()) {
      return first;
    }
    if (isObject(first)) {
      return (
        firstString(first, ["url", "imageUrl", "image", "thumbnail", "thumbnailUrl", "galleryURL", "pictureUrl"]) ?? ""
      );
    }
  }

  for (const value of Object.values(row)) {
    if (!isObject(value)) continue;
    const nested = firstString(value, ["imageUrl", "image", "thumbnail", "thumbnailUrl", "galleryURL", "pictureUrl"]);
    if (nested) return nested;
  }

  return "";
}

function pickBestListing(listings: Listing[], card: TargetCard, requireImage: boolean): Listing | undefined {
  return listings
    .filter((listing) => !requireImage || isUsableImageUrl(listing.imageUrl))
    .filter((listing) => isAllowedListingTitle(listing.title))
    .filter((listing) => listingMatchesCard(listing, card))
    .sort((a, b) => scoreListing(b, card) - scoreListing(a, card))[0];
}

function listingMatchesCard(listing: Listing, card: TargetCard): boolean {
  const text = normalizeSearchText(`${listing.title} ${listing.listingUrl}`);
  const cardWords = normalizeSearchText(card.cardName)
    .split(" ")
    .filter((word) => word.length >= 4);
  const matchingWords = cardWords.filter((word) => text.includes(word)).length;
  const bareCardNumber = card.cardNumber.replace(/^#/, "");
  const hasNumber =
    !card.cardNumber || text.includes(normalizeSearchText(card.cardNumber)) || text.includes(bareCardNumber);

  return text.includes("psa") && text.includes("10") && hasNumber && matchingWords >= Math.min(2, cardWords.length);
}

function scoreListing(listing: Listing, card: TargetCard): number {
  const text = normalizeSearchText(listing.title);
  let score = 0;
  if (listing.listingUrl.includes("ebay.")) score += 20;
  if (text.includes("psa 10") || text.includes("psa10")) score += 20;
  if (isUsableImageUrl(listing.imageUrl)) score += 15;
  if (text.includes("slab") || text.includes("graded")) score += 10;
  if (card.cardNumber && text.includes(card.cardNumber.replace(/^#/, ""))) score += 10;
  if (listing.soldAt) score += 5;
  return score;
}

function listingSearchQuery(card: TargetCard): string {
  const extras: string[] = [];
  if (card.cardName === "Charizard V" && card.cardNumber === "#050") {
    extras.push("SWSH050", "Champions Path");
  }
  return [card.cardName, card.cardNumber, ...extras, "Pokemon", "PSA 10"].filter(Boolean).join(" ");
}

function isAllowedListingTitle(title: string): boolean {
  const normalized = ` ${normalizeSearchText(title)} `;
  return !EXCLUDED_LISTING_TERMS.some((term) => normalized.includes(term));
}

function medianCents(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function parseListingPriceCents(value: unknown): number | undefined {
  const dollars = parseDollarAmount(value);
  if (dollars === undefined) {
    return parsePriceCents(value);
  }
  return Math.round(dollars * 100);
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
  const objectDate =
    parseDate(firstString(object, ["date", "snapshotDate", "snapshot_date", "createdAt", "created_at"])) ??
    inheritedDate;
  const directRows = firstArray(object, ["rows", "products", "items", "data", "prices", "snapshots", "price_snapshots"]);
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
    const date =
      parseDate(firstString(row, ["date", "snapshotDate", "snapshot_date", "createdAt", "created_at", "captured_at"])) ??
      fileDate;
    const productId = firstString(row, ["id", "product-id", "productId", "pricechartingId", "pricecharting_id"]);
    const productName = firstString(row, ["product-name", "productName", "name", "title", "cardName", "card_name"]);
    const consoleName = firstString(row, ["console-name", "consoleName", "set", "setName", "category"]) ?? "";
    const genre = firstString(row, ["genre", "category", "type"]) ?? "";
    const priceCents = firstPriceCents(row, [
      "manual-only-price",
      "price_cents",
      "priceCents",
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
    snapshots.push({
      cardName: cleanCardName(productName),
      cardNumber: extractCardNumber(row, productName),
      consoleName,
      date,
      genre,
      grade: "PSA 10",
      priceCents,
      productId,
      salesVolume: parseInteger(firstValue(row, ["sales-volume", "salesVolume", "volume"])) ?? 0,
      source: file,
    });
  }
  return snapshots;
}

function collectSnapshotFiles(path: string): string[] {
  if (!path || !existsSync(path)) return [];
  const stats = safeStat(path);
  if (!stats) return [];
  if (stats.isFile() && [".json", ".csv"].includes(extname(path).toLowerCase())) {
    return [path];
  }
  if (!stats.isDirectory()) return [];
  return readdirSync(path)
    .map((entry) => join(path, entry))
    .filter((entryPath) => {
      const entryStats = safeStat(entryPath);
      return Boolean(entryStats?.isFile() && [".json", ".csv"].includes(extname(entryPath).toLowerCase()));
    });
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

export function parseCsv(text: string): Row[] {
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

async function fetchJson(url: URL, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url.hostname}`);
  }
  return response.json();
}

function firstArrayDeep(value: unknown, keys: string[]): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (!isObject(value)) return undefined;
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

export function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9#]+/g, " ").replace(/\s+/g, " ").trim();
}

export function isUsableImageUrl(value: string): boolean {
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

function resolvePath(root: string, path: string): string {
  return isAbsolute(path) ? path : resolve(root, path);
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
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

function isFiniteNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
