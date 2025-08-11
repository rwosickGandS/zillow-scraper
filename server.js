// server.js
import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "1mb" }));

/**
 * Optional simple auth:
 *   - Set env var API_KEY="some-long-string"
 *   - Send header X-API-Key: <that-string> with requests
 */
const requireApiKey = !!process.env.API_KEY;
function checkApiKey(req, res) {
  if (!requireApiKey) return true;
  const key = req.get("X-API-Key");
  if (key && key === process.env.API_KEY) return true;
  res.status(401).json({ ok: false, error: "Unauthorized" });
  return false;
}

const PORT = process.env.PORT || 8080;

/* ---------------------------- small helpers ---------------------------- */

const slug = (s) =>
  String(s || "")
    .trim()
    .replace(/[.,#]/g, "")
    .replace(/\s+/g, "-")
    .toLowerCase();

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^\w]/g, "")
    .trim();

async function getNextData(page) {
  return await page.evaluate(() => {
    const el = document.querySelector('script#__NEXT_DATA__');
    return el ? el.textContent : null;
  });
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

  // Try common structured paths
  const tryPaths = (obj, paths) => {
    for (const p of paths) {
      try {
        const v = p.split(".").reduce((o, k) => (o ? o[k] : undefined), obj);
        if (v !== undefined && v !== null) return v;
      } catch (_) {}
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

  // Fallback: regex scan of full JSON string
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

/* ------------------------------- routes -------------------------------- */

app.get("/", (_req, res) => {
  res.send("zillow-scraper: ok");
});

app.post("/zestimate", async (req, res) => {
  if (!checkApiKey(req, res)) return;

  const { address, city, state, zip } = req.body || {};
  if (!address || !city || !state) {
    return res
      .status(400)
      .json({ ok: false, error: "address, city, state are required" });
  }

  const searchUrl = `https://www.zillow.com/homes/${slug(address)}-${slug(
    city
  )}-${slug(state)}${zip ? "-" + slug(zip) : ""}_rb/`;

  let browser;
  try {
    // Launch Chromium with flags that work in Render containers
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    });

    const ctx = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 900 }
    });
    const page = await ctx.newPage();

    // 1) Search page
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    const nextDataSearch = await getNextData(page);
    if (!nextDataSearch) {
      return res.status(200).json({
        ok: true,
        source: searchUrl,
        zestimate: null,
        zpid: null,
        property_url: null,
        match_confidence: 0,
        note: "No __NEXT_DATA__ on search page."
      });
    }

    const searchJson = JSON.parse(nextDataSearch);
    const results =
      searchJson?.props?.pageProps?.searchPageState?.cat1?.searchResults
        ?.listResults || [];

    const { best, score } = pickBestSearchResult(results, address, city);
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

    const detailUrl = best.detailUrl.startsWith("http")
      ? best.detailUrl
      : `https://www.zillow.com${best.detailUrl}`;

    // 2) Detail page
    await page.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    const nextDataDetail = await getNextData(page);

    if (!nextDataDetail) {
      return res.status(200).json({
        ok: true,
        source: searchUrl,
        property_url: detailUrl,
        zestimate: null,
        zpid: null,
        match_confidence: Math.max(10, score * 10),
        note: "No __NEXT_DATA__ on detail page."
      });
    }

    const detailJson = JSON.parse(nextDataDetail);

    const candidates = [
      detailJson?.props?.pageProps?.componentProps?.initialReduxState,
      detailJson?.props?.pageProps?.componentProps?.gdpClientCache,
      detailJson?.props?.pageProps,
      detailJson
    ];

    let zpid = null;
    let zestimate = null;

    for (const c of candidates) {
      const { zpid: zp, zestimate: ze } = extractZpidAndZestimate(c);
      if (zp && !zpid) zpid = zp;
      if (ze && !zestimate) zestimate = ze;
      if (zpid && zestimate) break;
    }

    return res.status(200).json({
      ok: true,
      source: searchUrl,
      property_url: detailUrl,
      zpid,
      zestimate,
      match_confidence: zestimate ? 90 : Math.max(20, score * 10)
    });
  } catch (err) {
    return res
      .status(200)
      .json({ ok: false, error: String(err?.message || err) });
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
  }
});

/* -------------------------------- start -------------------------------- */

app.listen(PORT, () => {
  console.log(`Listening on :${PORT}`);
});
