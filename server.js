import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "1mb" }));

// Helper: hyphenate address parts for Zillow search URLs
const slug = s =>
  String(s || "")
    .trim()
    .replace(/[.,]/g, "")
    .replace(/\s+/g, "-")
    .toLowerCase();

app.post("/zestimate", async (req, res) => {
  const { address, city, state, zip } = req.body || {};
  if (!address || !city || !state) {
    return res.status(400).json({ ok: false, error: "address, city, state required" });
  }

  const searchUrl = `https://www.zillow.com/homes/${slug(address)}-${slug(city)}-${slug(state)}${zip ? "-" + slug(zip) : ""}_rb/`;

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 900 }
    });
    const page = await ctx.newPage();

    // 1) Open the Zillow search page for the formatted address
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45000 });

    // Grab Zillow’s Next.js data from the search page
    const nextDataSearch = await page.evaluate(() => {
      const el = document.querySelector('script#__NEXT_DATA__');
      return el ? el.textContent : null;
    });

    if (!nextDataSearch) {
      throw new Error("Could not read search data");
    }

    const searchJson = JSON.parse(nextDataSearch);
    const results =
      searchJson?.props?.pageProps?.searchPageState?.cat1?.searchResults?.listResults || [];

    // Try to find the best matching result (simple contains match)
    const target = results.find(r => {
      const a = (r?.address || "").toLowerCase();
      return a.includes(String(address).toLowerCase()) && a.includes(String(city).toLowerCase());
    }) || results[0];

    if (!target || !target.detailUrl) {
      return res.status(200).json({
        ok: true,
        source: searchUrl,
        match_confidence: 0,
        zestimate: null,
        property_url: null,
        note: "No matching property found on search page."
      });
    }

    // 2) Open the property detail page
    const detailUrl = target.detailUrl.startsWith("http")
      ? target.detailUrl
      : `https://www.zillow.com${target.detailUrl}`;
    await page.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 45000 });

    const nextDataDetail = await page.evaluate(() => {
      const el = document.querySelector('script#__NEXT_DATA__');
      return el ? el.textContent : null;
    });

    if (!nextDataDetail) {
      return res.status(200).json({
        ok: true,
        source: searchUrl,
        match_confidence: 50,
        zestimate: null,
        property_url: detailUrl,
        note: "No detail JSON found."
      });
    }

    const detailJson = JSON.parse(nextDataDetail);

    // Zillow nests the property payload differently depending on page version; search a few likely paths
    const candidates = [
      detailJson?.props?.pageProps?.componentProps?.initialReduxState?.homeDetails,
      detailJson?.props?.pageProps?.componentProps?.gdpClientCache,
      detailJson?.props?.pageProps
    ];

    let zestimate = null;
    let zpid = null;

    // Try to find a zestimate in known places
    for (const c of candidates) {
      if (!c) continue;
      const str = JSON.stringify(c);
      const match = str.match(/"zestimate"\s*:\s*(\d{4,9})/);
      if (match) {
        zestimate = Number(match[1]);
      }
      const zpidMatch = str.match(/"zpid"\s*:\s*"?(?\d+)"?/);
      if (zestimate && zpidMatch) break;
    }

    res.status(200).json({
      ok: true,
      source: searchUrl,
      property_url: detailUrl,
      zestimate,
      zpid,
      match_confidence: zestimate ? 90 : 50
    });
  } catch (err) {
    res.status(200).json({ ok: false, error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

// Healthcheck
app.get("/", (_, res) => res.send("zillow-scraper: ok"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Listening on :${PORT}`));
