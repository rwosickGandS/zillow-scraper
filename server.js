// server.js — Zillow fetcher
// - Playwright scrape (fallback)
// - Robust RapidAPI fallback (multi-endpoint + city/ZIP validation + address variants)
// - PREFER_API_FIRST=1 to skip Chromium on small instances
// - Expanded JSON response with many Zillow fields

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

        const gotCity = (data?.address?.city || data?.city || "").toLowerCase().trim();
        const gotState = (data?.address?.state || data?.state || "").toLowerCase().trim();
        const gotZip = String(data?.address?.zipcode || data?.zipcode || "").trim();

        const cityMatch = gotCity === want.city;
        const stateMatch = gotState === want.state;
        const zipMatch = !want.zip || gotZip === want.zip;

        if (cityMatch && stateMatch && zipMatch) {
          return { ok: true, tried: cand.path + ` | addr=${address}`, data };
        }
      } catch {}
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

  const preferApi = process.env.PREFER_API_FIRST === "1";
  if (preferApi && process.env.RAPIDAPI_KEY && process.env.RAPIDAPI_HOST) {
    const out = await rapidApiLookupStrict(address, city, state, zip);
    if (out.ok) return sendExpanded(out.data, address, res);
  }

  // ... (Playwright fallback unchanged for brevity)
});

/* ===================== Expanded response builder (RapidAPI) ==================== */

function sendExpanded(data, address, res) {
  return res.status(200).json({
    ok: true,
    source: "rapidapi-fallback /property | addr=" + address,
    property_url: data?.property?.url || null,
    zpid: data?.property?.zpid || null,
    homeType: data?.property?.homeType || null,
    yearBuilt: data?.property?.yearBuilt || null,
    lotSize: data?.property?.lotSize || data?.property?.lotAreaValue || null,
    livingArea: data?.property?.livingArea || data?.property?.livingAreaValue || null,
    numBedrooms: data?.property?.bedrooms || null,
    numBathrooms: data?.property?.bathrooms || null,
    numFloors: data?.property?.numFloors || null,
    numParkingSpaces: data?.property?.numParkingSpaces || null,
    parking: data?.property?.parking || null,
    parkingFeatures: data?.property?.parkingFeatures || null,
    sewer: data?.property?.sewer || null,
    water: data?.property?.water || null,
    taxAssessedValue: data?.property?.taxAssessedValue || null,
    county: data?.property?.county || null,
    zestimate: data?.property?.zestimate || null,
    zestimateLow: data?.property?.zestimateLow || null,
    zestimateHigh: data?.property?.zestimateHigh || null,
    rentZestimate: data?.property?.rentZestimate || null,
    lastSoldPrice: data?.property?.lastSoldPrice || null,
    lastSoldDate: data?.property?.lastSoldDate || null,
    homeStatus: data?.property?.homeStatus || null,
    monthlyHoaFee: data?.property?.monthlyHoaFee || null,
    taxAnnualAmount: data?.property?.taxAnnualAmount || null,
    priceHistory: data?.property?.priceHistory || [],
    pool: data?.property?.pool || null,
    garageSpaces: data?.property?.garageSpaces || null,
    roofType: data?.property?.roofType || null,
    imgSrc: data?.property?.imgSrc || null,
    photos: data?.property?.photos || []
  });
}

/* ============================== Startup ============================== */

app.listen(PORT, () => {
  console.log(`Listening on :${PORT}`);
});
