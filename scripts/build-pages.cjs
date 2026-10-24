#!/usr/bin/env node
// Builds real, crawlable addresses for the public pages
// (co2counter.co.uk/about/, /greener-switches/ ...) plus sitemap.xml.
//
// Each page is a copy of index.html with its own title, description and
// canonical URL, <base href="/"> so the same assets load, and a snapshot
// of the page's content in <main id="app"> for search engines. The app
// then starts as normal and redraws it (see PAGE_PATHS in app.js).
//
// Run after changing index.html or a public page, from the repo root:
//   npm i --no-save playwright && npx playwright install chromium
//   node scripts/build-pages.cjs
const fs = require("fs");
const path = require("path");
const http = require("http");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const SITE = "https://co2counter.co.uk";
const PAGES = [
  { dir: "about", route: "/about", title: "About CO2 Counter · a free, independent UK carbon footprint calculator", desc: "Who runs CO2 Counter, where the numbers come from, how we choose partners and how affiliate links work." },
  { dir: "greener-switches", route: "/switches", title: "Greener switches · the changes that cut your carbon footprint most | CO2 Counter", desc: "Renewable energy, greener banks, plant-forward food and the train instead of the plane: what each switch saves, and where to start." },
  { dir: "how-we-calculate", route: "/how-we-calculate", title: "How we calculate your carbon footprint | CO2 Counter", desc: "The official UK emission factors and published data behind CO2 Counter's estimates, and how we keep them up to date." },
  { dir: "example", route: "/example", title: "Example carbon footprint result for a typical UK resident | CO2 Counter", desc: "See the results a typical UK resident gets: where their carbon footprint comes from and the realistic changes that cut it most." },
  { dir: "privacy", route: "/privacy", title: "Privacy policy | CO2 Counter", desc: "What CO2 Counter collects, why, who it is shared with and your rights." },
  { dir: "terms", route: "/terms", title: "Terms of use | CO2 Counter", desc: "The terms for using CO2 Counter." },
];

const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function serve() {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
  return http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p.endsWith("/")) p += "index.html";
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
}

(async () => {
  const template = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const server = serve().listen(0);
  const port = server.address().port;
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // A signed-out visitor; no network beyond the local files.
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (r) => r.abort());
  const page = await ctx.newPage();
  for (const pg of PAGES) {
    await page.goto(`http://127.0.0.1:${port}/#${pg.route}`);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForTimeout(4500);
    const snapshot = await page.evaluate(() => document.getElementById("app").innerHTML);
    if (!snapshot || snapshot.length < 500) throw new Error("Empty snapshot for " + pg.route);
    const url = `${SITE}/${pg.dir}/`;
    let html = template
      .replace('<meta charset="UTF-8" />', '<meta charset="UTF-8" />\n<base href="/" />')
      .replace(/<title>[^<]*<\/title>/, `<title>${esc(pg.title)}</title>`)
      .replace(/<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${esc(pg.desc)}" />`)
      .replace(/<meta property="og:title" content="[^"]*" \/>/, `<meta property="og:title" content="${esc(pg.title)}" />`)
      .replace(/<meta property="og:description" content="[^"]*" \/>/, `<meta property="og:description" content="${esc(pg.desc)}" />`)
      .replace(/<meta property="og:url" content="[^"]*" \/>/, `<meta property="og:url" content="${url}" />`)
      .replace(/<link rel="canonical" href="[^"]*" \/>/, `<link rel="canonical" href="${url}" />`)
      .replace('<main id="app"></main>', `<main id="app">${snapshot}</main>`);
    if (!html.includes(`<link rel="canonical" href="${url}" />`) || !html.includes(snapshot)) throw new Error("Template markers missing for " + pg.dir);
    html = "<!-- Built by scripts/build-pages.cjs from index.html. Don't edit by hand. -->\n" + html;
    fs.mkdirSync(path.join(ROOT, pg.dir), { recursive: true });
    fs.writeFileSync(path.join(ROOT, pg.dir, "index.html"), html);
    console.log("built /" + pg.dir + "/ (" + Math.round(html.length / 1024) + " KB)");
  }
  await browser.close();
  server.close();
  const today = new Date().toISOString().slice(0, 10);
  const urls = [`${SITE}/`].concat(PAGES.map((p) => `${SITE}/${p.dir}/`));
  fs.writeFileSync(
    path.join(ROOT, "sitemap.xml"),
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      urls.map((u) => `  <url><loc>${u}</loc><lastmod>${today}</lastmod></url>`).join("\n") + "\n</urlset>\n"
  );
  console.log("built sitemap.xml (" + urls.length + " pages)");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
