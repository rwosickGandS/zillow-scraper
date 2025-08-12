// server.js — Zillow fetcher
// - Playwright scrape (fallback)
// - Robust RapidAPI fallback (multi-endpoint + city/ZIP validation + address variants)
// - PREFER_API_FIRST=1 to skip Chromium on small instances
// - Expanded JSON response with many Zillow fields (incl. parking, sewer, water, taxAssessedValue)

import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "1mb" }));

/* ============================ Config / Auth ============================ */

// Optional simple auth:
//   set API_KEY in your environment, and send X-API-Key header with requests.
const requireApiKey = !!process.env.API_KEY;
function checkApiKey(req, res) {
  if (!requireApiKey) return true;
  const key = req.get("X-API-Key");
  if (key && key === process.env.API_KEY) return true;
  res.status(401).json({ ok: false, error: "Unauthorized" });
  return false;
}

const PORT = process.env.PORT || 8080;

/* =============================== Helpers ============================== */

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^\w]/g, "")
    .trim();

function buildSearchUrl(address, city, state, zip) {
  const usersSearchTerm = [address, city, state, zip].filter(Boolean).join(", ");
  const sqs = {
    pagination: {},
    mapBounds: { west: -180, east: 180, south: -90, north: 90 },
    usersSearchTerm,
    regionSelection: [],
    isMapVisible: false,
    filterState: {},
    isListVisible: true,
  };
  const enc = encodeURIComponent(JSON.stringify(sqs));
  return `https://www.zillow.com/homes/?searchQueryState=${enc}`;
}

async function getTextFrom(page, selector) {
  return await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? el.textContent : null;
  }, selector);
}

async function waitAndGetAnyDataBlob(page) {
  await page.waitForTimeout(1200);
  await page.mouse.wheel(0, 800);
  await page.waitForTimeout(800);
  const selectors = [
    'script#__NEXT_DATA__',
    'script[data-zrr-shared-data-key="searchPageStore"]',
    'script[data-zrr-shared-data-key="mobileSearchPageStore"]',
  ];
  for (const sel of selectors) {
    const txt = await getTextFrom(page, sel);
    if (txt) return { selector: sel, text: txt };
  }
  return null;
}

function pickBestSearchResult(results, address, city) {
  const targetAddr = norm(address);
  const targetCity = norm(city);
  let best = null;
  let bestScore = -1;

  for (const r of results || []) {
    const addrText = norm(r?.address || "");
    let score = 0;
    if (addrText.includes(targetAddr)) score += 2;
    if (addrText.includes(targetCity)) score += 1;
    if (score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  return { best, score: bestScore };
}

function extractZpidAndZestimate(anyObj) {
  if (!anyObj) return { zpid: null, zestimate: null };
  const tryPaths = (obj, paths) => {
    for (const p of paths) {
      try {
        const v = p.split(".").reduce((o, k) => (o ? o[k] : undefined), obj);
        if (v !== undefined && v !== null) return v;
      } catch {}
    }
    return undefined;
  };

  const zestimateCandidate = tryPaths(anyObj, [
    "homeInfo.zestimate",
    "zestimate",
    "property.zestimate",
    "homeDetails.zestimate",
    "props.pageProps.componentProps.gdpClientCache.default.zestimate",
  ]);

  const zpidCandidate = tryPaths(anyObj, [
    "homeInfo.zpid",
    "zpid",
    "property.zpid",
    "props.pageProps.componentProps.zpid",
  ]);

  let zestimate = typeof zestimateCandidate === "number" ? zestimateCandidate : null;
  let zpid =
    typeof zpidCandidate === "number" || typeof zpidCandidate === "string"
      ? Number(String(zpidCandidate).replace(/\D/g, "")) || null
      : null;

  // Fallback regex scan
  const asStr = JSON.stringify(anyObj);
  if (!zestimate) {
    const m = asStr.match(/"zestimate"\s*:\s*(\d{4,9})/);
    if (m) zestimate = Number(m[1]);
  }
  if (!zpid) {
    const m2 = asStr.match(/"zpid"\s*:\s*"?(\d+)"?/);
    if (m2) zpid = Number(m2[1]);
  }

  return { zpid, zestimate };
}

/* -------- Address variant generation (directionals + abbrev/expanded) -------- */

function generateAddressVariants(address) {
  const variants = new Set();
  const base = String(address || "").trim();
  if (!base) return [];

  variants.add(base);

  const abbrToFull = {
    " St ": " Street ",
    " Dr ": " Drive ",
    " Rd ": " Road ",
    " Ave ": " Avenue ",
    " Ln ": " Lane ",
    " Ct ": " Court ",
    " Blvd ": " Boulevard ",
    " Pkwy ": " Parkway ",
    " Ter ": " Terrace ",
    " Cir ": " Circle ",
  };
  const fullToAbbr = {
    " Street ": " St ",
    " Drive ": " Dr ",
    " Road ": " Rd ",
    " Avenue ": " Ave ",
    " Lane ": " Ln ",
    " Court ": " Ct ",
    " Boulevard ": " Blvd ",
    " Parkway ": " Pkwy ",
    " Terrace ": " Ter ",
    " Circle ": " Cir ",
  };

  const swapWords = (s, map) => {
    let t = ` ${s} `;
    for (const [k, v] of Object.entries(map)) {
      t = t.replace(new RegExp(k, "gi"), v);
    }
    return t.trim();
  };

  variants.add(swapWords(base, abbrToFull));
  variants.add(swapWords(base, fullToAbbr));

  // Add directional after house number if not already present
  const hasDirectional = /\b(N|S|E|W|NE|NW|SE|SW)\b/i.test(base);
  if (!hasDirectional) {
    const m2 = base.match(/^(\d+)\s+(.*)$/);
    if (m2) {
      for (const d of ["E", "W", "N", "S"]) {
        variants.add(`${m2[1]} ${d} ${m2[2]}`);
      }
    }
  }

  return Array.from(variants).filter(Boolean);
}

/* -------- Robust RapidAPI lookup (multi-endpoint + strict validation) -------- */

async function rapidApiLookupStrict(address, city, state, zip) {
  const host = process.env.RAPIDAPI_HOST;
  const key = process.env.RAPIDAPI_KEY;
  if (!host || !key) return { ok: false, reason: "missing-keys" };

  const want = {
    city: (city || "").toLowerCase().trim(),
    state: (state || "").toLowerCase().trim(),
    zip: String(zip || "").trim(),
  };

  const candidates = [
    { path: "/property", params: (a, c, s, z) => ({ address: a, citystatezip: `${c}, ${s} ${z || ""}`.trim() }) },
    { path: "/propertyExtended", params: (a, c, s, z) => ({ address: a, citystatezip: `${c}, ${s} ${z || ""}`.trim() }) },
    { path: "/propertyByAddress", params: (a, c, s, z) => ({ address: a, citystatezip: `${c}, ${s} ${z || ""}`.trim() }) },
    { path: "/property", params: (a, c, s, z) => ({ address: a, city: c, state: s, zipcode: z || "" }) },
    { path: "/propertyDetails", params: (a, c, s, z) => ({ address: a, city: c, state: s, zipcode: z || "" }) },
  ];

  const toQuery = (obj) =>
    Object.entries(obj)
      .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");

  const addrs = generateAddressVariants(address);

  for (const a of addrs) {
    for (const cand of candidates) {
      try {
        const qs = cand.params(a, city, state, zip);
        const url = `https://${host}${cand.path}?${toQuery(qs)}`;

        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 20000);
        const resp = await fetch(url, {
          headers: { "X-RapidAPI-Key": key, "X-RapidAPI-Host": host },
          signal: ac.signal,
        });
        clearTimeout(t);

        if (!resp.ok) continue;

        const data = await resp.json();

        // Normalize returned address
        const gotCity = (data?.address?.city || data?.city || "").toLowerCase().trim();
        const gotState = (data?.address?.state || data?.state || "").toLowerCase().trim();
        const gotZip = String(data?.address?.zipcode || data?.zipcode || "").trim();

        const cityMatch = gotCity === want.city;
        const stateMatch = gotState === want.state;
        const zipMatch = !want.zip || gotZip === want.zip;

        // Extract essentials
        const zestimate =
          data?.zestimate ?? data?.result?.zestimate ?? data?.data?.zestimate ?? null;
        const zpid = data?.zpid ?? data?.result?.zpid ?? data?.data?.zpid ?? null;

        const rawUrl = data?.url ?? data?.result?.url ?? data?.data?.url ?? null;
        const property_url = rawUrl
          ? String(rawUrl).startsWith("http")
            ? rawUrl
            : `https://www.zillow.com${rawUrl}`
          : null;

        if (cityMatch && stateMatch && zipMatch && (zestimate || zpid)) {
          return {
            ok: true,
            tried: cand.path + ` | addr="${a}"`,
            zestimate,
            zpid,
            property_url,
            data, // pass the raw payload so we can map lots of fields in the route
          };
        }
      } catch {
        // ignore and try next candidate/variant
      }
    }
  }

  return { ok: false, reason: "no-matching-record" };
}

/* =============================== Routes =============================== */

app.get("/", (_req, res) => res.send("zillow-scraper: ok"));

app.post("/zestimate", async (req, res) => {
  if (!checkApiKey(req, res)) return;

  const { address, city, state, zip } = req.body || {};
  if (!address || !city || !state) {
    return res
      .status(400)
      .json({ ok: false, error: "address, city, state are required" });
  }

  // Prefer RapidAPI first on small instances
  const preferApi = process.env.PREFER_API_FIRST === "1";
  if (preferApi && process.env.RAPIDAPI_KEY && process.env.RAPIDAPI_HOST) {
    const out = await rapidApiLookupStrict(address, city, state, zip);
    if (out.ok) return sendExpanded(out, res);
    // fall through to Playwright if API couldn't match
  }

  const searchUrl = buildSearchUrl(address, city, state, zip);

  let browser;
  try {
    // Playwright Chromium
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    const ctx = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 900 },
      locale: "en-US",
    });
    const page = await ctx.newPage();

    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

    const blob = await waitAndGetAnyDataBlob(page);
    if (!blob) {
      // Try RapidAPI fallback
      if (process.env.RAPIDAPI_KEY && process.env.RAPIDAPI_HOST) {
        const out = await rapidApiLookupStrict(address, city, state, zip);
        if (out.ok) return sendExpanded(out, res);
        return res.status(200).json({
          ok: true,
          source: "rapidapi-fallback",
          zestimate: null,
          zpid: null,
          property_url: null,
          match_confidence: 0,
          note: "No matching record from RapidAPI for the requested city/ZIP.",
        });
      }

      return res.status(200).json({
        ok: true,
        source: searchUrl,
        zestimate: null,
        zpid: null,
        property_url: null,
        match_confidence: 0,
        note: "No search data blob found.",
      });
    }

    // Parse search results
    let root = null;
    try {
      root = JSON.parse(blob.text);
    } catch {}

    let listResults =
      root?.props?.pageProps?.searchPageState?.cat1?.searchResults?.listResults;

    if (!Array.isArray(listResults)) {
      try {
        const store = JSON.parse(blob.text);
        listResults =
          store?.cat1?.searchResults?.listResults ||
          store?.searchResults?.listResults ||
          null;
      } catch {}
    }

    if (!Array.isArray(listResults) || listResults.length === 0) {
      return res.status(200).json({
        ok: true,
        source: searchUrl,
        zestimate: null,
        zpid: null,
        property_url: null,
        match_confidence: 0,
        note: "No search results in blob.",
      });
    }

    const { best, score } = pickBestSearchResult(listResults, address, city);
    if (!best || !best.detailUrl) {
      return res.status(200).json({
        ok: true,
        source: searchUrl,
        zestimate: null,
        zpid: null,
        property_url: null,
        match_confidence: 0,
        note: "No matching property found.",
      });
    }

    const detailUrl = best.detailUrl.startsWith("http")
      ? best.detailUrl
      : `https://www.zillow.com${best.detailUrl}`;

    await page.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

    const detailBlob = await waitAndGetAnyDataBlob(page);

    let zpid = null;
    let zestimate = null;

    // NEW: fields requested for Playwright path
    let parking = null;
    let parkingFeatures = null;
    let sewer = null;
    let water = null;
    let taxAssessedValue = null;
    let county = null;

    if (detailBlob) {
      try {
        const detailRoot = JSON.parse(detailBlob.text);
        const candidates = [
          detailRoot?.props?.pageProps?.componentProps?.initialReduxState,
          detailRoot?.props?.pageProps?.componentProps?.gdpClientCache,
          detailRoot?.props?.pageProps,
          detailRoot,
        ];
        for (const c of candidates) {
          const { zpid: zp, zestimate: ze } = extractZpidAndZestimate(c);
          if (zp && !zpid) zpid = zp;
          if (ze && !zestimate) zestimate = ze;

          // attempt to pick extra details from common Zillow shapes
          const tryPick = (paths) => {
            for (const p of paths) {
              try {
                const v = p.split(".").reduce((o, k) => (o ? o[k] : undefined), c);
                if (v !== undefined && v !== null) return v;
              } catch {}
            }
            return null;
          };

          if (parking === null)
            parking = tryPick([
              "property.parking",
              "homeDetails.parking",
              "resoFacts.parking",
              "data.parking",
            ]);

          if (parkingFeatures === null)
            parkingFeatures = tryPick([
              "resoFacts.parkingFeatures",
              "homeFacts.parkingFeatures",
              "property.parkingFeatures",
              "data.parkingFeatures",
            ]);

          if (sewer === null)
            sewer = tryPick([
              "resoFacts.sewer",
              "homeFacts.sewer",
              "property.sewer",
              "data.sewer",
            ]);

          if (water === null)
            water = tryPick([
              "resoFacts.waterSource",
              "homeFacts.water",
              "homeFacts.waterSource",
              "property.waterSource",
              "property.water",
              "data.waterSource",
              "data.water",
            ]);

          if (taxAssessedValue === null)
            taxAssessedValue = tryPick([
              "taxAssessedValue",
              "resoFacts.taxAssessedValue",
              "homeFacts.taxAssessedValue",
              "property.taxAssessedValue",
              "data.taxAssessedValue",
            ]);

          if (county === null)
            county = tryPick([
              "address.county",
              "property.address.county",
              "result.address.county",
              "county",
              "property.county",
            ]);

          if (zpid && zestimate && (parking !== null || sewer !== null || water !== null || taxAssessedValue !== null || county !== null)) {
            // good enough; continue to response
          }
        }
      } catch {}
    }

    return res.status(200).json({
      ok: true,
      source: searchUrl,
      property_url: detailUrl,
      zpid,
      zestimate,
      match_confidence: zestimate ? 90 : Math.max(20, (score || 0) * 10),

      // Added Zillow info (Playwright path)
      parking,
      parkingFeatures,
      sewer,
      water,
      taxAssessedValue,
      county,
    });
  } catch (err) {
    return res.status(200).json({ ok: false, error: String(err?.message || err) });
  } finally {
    try {
      if (browser) await browser.close();
    } catch {}
  }
});

/* ===================== Expanded response builder (RapidAPI) ==================== */

function sendExpanded(out, res) {
  const d = out.data || {};

  const pick = (...paths) => {
    for (const p of paths) {
      try {
        const v = p.split(".").reduce((o, k) => (o ? o[k] : undefined), d);
        if (v !== undefined && v !== null) return v;
      } catch {}
    }
    return null;
  };

  const zestimate =
    out.zestimate ??
    (pick("zestimate") ?? pick("result.zestimate") ?? pick("data.zestimate"));

  // Low/High absolute or derived from percent bands if available
  const zLowAbs = pick("zestimateLow", "result.zestimateLow", "data.zestimateLow");
  const zHighAbs = pick("zestimateHigh", "result.zestimateHigh", "data.zestimateHigh");
  const zLowPct = Number(pick("zestimateLowPercent", "result.zestimateLowPercent", "data.zestimateLowPercent"));
  const zHighPct = Number(pick("zestimateHighPercent", "result.zestimateHighPercent", "data.zestimateHighPercent"));

  const zestimateLow =
    zLowAbs ??
    (Number.isFinite(zestimate) && Number.isFinite(zLowPct)
      ? Math.round(zestimate * (1 - zLowPct / 100))
      : null);

  const zestimateHigh =
    zHighAbs ??
    (Number.isFinite(zestimate) && Number.isFinite(zHighPct)
      ? Math.round(zestimate * (1 + zHighPct / 100))
      : null);

  const priceHistory = pick("priceHistory", "result.priceHistory") || [];

  // Derive last sold from history if not provided directly
  const lastSoldDirectPrice = pick("lastSoldPrice", "result.lastSoldPrice");
  const lastSoldDirectDate = pick("lastSoldDate", "result.lastSoldDate");
  let lastSoldPrice = lastSoldDirectPrice;
  let lastSoldDate = lastSoldDirectDate;

  if ((!lastSoldPrice || !lastSoldDate) && Array.isArray(priceHistory)) {
    const sold = priceHistory.find((e) =>
      String(e?.event || e?.type || "").toLowerCase().includes("sold")
    );
    if (!lastSoldPrice && sold?.price != null) lastSoldPrice = sold.price;
    if (!lastSoldDate && sold?.date) lastSoldDate = sold.date;
  }

  const property_url = out.property_url;

  const payload = {
    ok: true,
    source: `rapidapi-fallback ${out.tried}`,
    property_url,

    // Identification
    zpid: out.zpid ?? pick("zpid", "result.zpid", "data.zpid"),

    // Basic property info
    homeType: pick("homeType", "propertyTypeDimension", "result.homeType", "data.homeType"),
    yearBuilt: pick("yearBuilt", "result.yearBuilt"),
    lotSize: pick("lotSize", "lotAreaValue", "result.lotSize", "result.lotAreaValue"),
    livingArea: pick("livingArea", "livingAreaValue", "result.livingArea", "result.livingAreaValue"),
    numBedrooms: pick("bedrooms", "numBedrooms", "result.bedrooms", "result.numBedrooms"),
    numBathrooms: pick("bathrooms", "bathroomsFloat", "numBathrooms", "result.bathrooms", "result.bathroomsFloat"),
    numFloors: pick("stories", "storiesDecimal", "result.stories", "result.storiesDecimal"),
    numParkingSpaces: pick(
      "parkingCapacity",
      "garageParkingCapacity",
      "coveredParkingCapacity",
      "result.parkingCapacity",
      "result.garageParkingCapacity",
      "result.coveredParkingCapacity"
    ),

    // Valuation / price
    zestimate,
    zestimateLow,
    zestimateHigh,
    rentZestimate: pick("rentZestimate", "result.rentZestimate"),

    // Last sold info
    lastSoldPrice,
    lastSoldDate,

    // Status & costs
    homeStatus: pick("homeStatus", "result.homeStatus"),
    monthlyHoaFee: pick("monthlyHoaFee", "result.monthlyHoaFee"),
    taxAnnualAmount: pick("taxAnnualAmount", "result.taxAnnualAmount"),
    taxAssessedValue: pick("taxAssessedValue", "resoFacts.taxAssessedValue", "result.taxAssessedValue"),

    // History arrays
    priceHistory,

    // Features
    pool:
      pick("hasPrivatePool", "pool", "result.hasPrivatePool", "result.pool") ??
      (Array.isArray(pick("poolFeatures")) ? true : null),
    garageSpaces: pick("garageParkingCapacity", "coveredParkingCapacity", "result.garageParkingCapacity"),
    roofType: pick("roofType", "result.roofType"),

    // NEW: Parking + utilities
    parking: pick("parking", "otherParking", "result.parking", "result.otherParking"),
    parkingFeatures: pick("parkingFeatures", "result.parkingFeatures"),
    sewer: pick("sewer", "result.sewer"),
    water: pick("waterSource", "water", "result.waterSource", "result.water"),

    // Media
    imgSrc: pick("imgSrc", "result.imgSrc"),
    photos: pick("photos", "result.photos", "miniCardPhotos") || [],

    // Location
    county: pick("county", "address.county", "result.county", "result.address.county"),

    // Confidence
    match_confidence: zestimate ? 85 : 60,

    // (Optional) include raw for debugging/mapping in Zapier:
    // raw: d
  };

  return res.status(200).json(payload);
}

/* ============================== Startup ============================== */

app.listen(PORT, () => {
  console.log(`Listening on :${PORT}`);
});
