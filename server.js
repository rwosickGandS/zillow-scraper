// server.js (resilient search + multiple data sources)
import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "1mb" }));

const requireApiKey = !!process.env.API_KEY;
function checkApiKey(req, res) {
  if (!requireApiKey) return true;
  const key = req.get("X-API-Key");
  if (key && key === process.env.API_KEY) return true;
  res.status(401).json({ ok: false, error: "Unauthorized" });
  return false;
}

const PORT = process.env.PORT || 8080;

/* ---------------------------- helpers ---------------------------- */

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^\w]/g, "")
    .trim();

function buildSearchUrl(address, city, state, zip) {
  // Use encoded searchQueryState which Zillow accepts reliably
  const usersSearchTerm = [address, city, state, zip].filter(Boolean).join(", ");
  const sqs = {
    pagination: {},
    mapBounds: { west: -180, east: 180, south: -90, north: 90 },
    usersSearchTerm,
    regionSelection: [],
    isMapVisible: false,
    filterState: {},
    isListVisible: true
  };
  const enc = encodeURIComponent(JSON.stringify(sqs));
  return `https://www.zillow.com/homes/?searchQueryState=${enc}`;
}

async function waitAndGetAnyDataBlob(page) {
  // Give the page a moment to render dynamic content
  await page.waitForTimeout(1200);
  // Try several known script containers
  const keys = [
    'script#__NEXT_DATA__',
    'script[data-zrr-shared-data-key="searchPageStore"]',
    'script[data-zrr-shared-data-key="mobileSearchPageStore"]'
  ];
  for (const sel of keys) {
    const txt = await page.evaluate((selector) => {
      const el = document.querySelector(selector);
      return el ? el.textContent : null;
    }, sel);
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
    "props.pageProps.componentProps.gdpClientCache.default.zestimate"
  ]);

  const zpidCandidate = tryPaths(anyObj, [
    "homeInfo.zpid",
    "zpid",
    "property.zpid",
    "props.pageProps.componentProps.zpid"
  ]);

  let zestimate =
    typeof zestimateCandidate === "number" ? zestimateCandidate : null;

  let zpid =
    typeof zpidCandidate === "number" || typeof zpidCandidate === "string"
      ? Number(String(zpidCandidate).replace(/\D/g, "")) || null
      : null;

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

/* ----------------------------- routes ----------------------------- */

app.get("/", (_req, res) => res.send("zillow-scraper: ok"));

app.post("/zestimate", async (req, res) => {
  if (!checkApiKey(req, res)) return;

  const { address, city, state, zip } = req.body || {};
  if (!address || !city || !state) {
    return res.status(400).json({ ok: false, error: "address, city, state are required" });
  }

  const searchUrl = buildSearchUrl(address, city, state, zip);

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    });
    const ctx = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 900 },
      locale: "en-US"
    });
    const page = await ctx.newPage();

    // 1) Open encoded search page
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45000 });

    // 2) Try to locate any embedded data blob
    const blob = await waitAndGetAnyDataBlob(page);
    if (!blob) {
      return res.status(200).json({
        ok: true,
        source: searchUrl,
        zestimate: null,
        zpid: null,
        property_url: null,
        match_confidence: 0,
        note: "No search data blob found."
      });
    }

    // 3) Parse and find search results
    let root;
    try {
      root = JSON.parse(blob.text);
    } catch {
      // Some older blobs are JS objects in a string; make one more attempt
      root = null;
    }

    // Try modern path first
    let listResults =
      root?.props?.pageProps?.searchPageState?.cat1?.searchResults?.listResults;

    // Try legacy search store blobs
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
        note: "No search results in blob."
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
        note: "No matching property found."
      });
    }

    // 4) Open detail page and extract values
    const detailUrl = best.detailUrl.startsWith("http")
      ? best.detailUrl
      : `https://www.zillow.com${best.detailUrl}`;
    await page.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 45000 });

    // Try detail blobs
    const detailBlob = await waitAndGetAnyDataBlob(page);
    let zpid = null;
    let zestimate = null;

    if (detailBlob) {
      try {
        const detailRoot = JSON.parse(detailBlob.text);
        const candidates = [
          detailRoot?.props?.pageProps?.componentProps?.initialReduxState,
          detailRoot?.props?.pageProps?.componentProps?.gdpClientCache,
          detailRoot?.props?.pageProps,
          detailRoot
        ];
        for (const c of candidates) {
          const { zpid: zp, zestimate: ze } = extractZpidAndZestimate(c);
          if (zp && !zpid) zpid = zp;
          if (ze && !zestimate) zestimate = ze;
          if (zpid && zestimate) break;
        }
      } catch {}
    }

    return res.status(200).json({
      ok: true,
      source: searchUrl,
      property_url: detailUrl,
      zpid,
      zestimate,
      match_confidence: zestimate ? 90 : Math.max(20, (score || 0) * 10)
    });
  } catch (err) {
    return res.status(200).json({ ok: false, error: String(err?.message || err) });
  } finally {
    try { if (browser) await browser.close(); } catch {}
  }
});

/* ------------------------------ start ------------------------------ */

app.listen(PORT, () => {
  console.log(`Listening on :${PORT}`);
});
