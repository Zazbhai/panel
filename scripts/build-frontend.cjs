// Inline shared frontend assets because the existing server serves a fixed asset list.
// This keeps the redesign independent of backend routes and configuration.
const { readFileSync, writeFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const root = join(__dirname, "..");
const css = readFileSync(join(root, "frontend", "dashboard.css"), "utf8").trim();
const ui = readFileSync(join(root, "frontend", "dashboard-ui.js"), "utf8").trim();
const pages = ["index", "active-devices", "services", "rotation", "service-messages", "recent-orders", "api-docs", "stocks"];
const requestedPages = process.argv.slice(2);
if (requestedPages.some((page) => !pages.includes(page))) throw new Error("Unknown frontend page.");
const targetPages = requestedPages.length ? requestedPages : pages;
for (const page of targetPages) {
  const file = join(root, `${page}.html`);
  let html = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  html = html.replace(/\s*<style\b[^>]*>[\s\S]*?<\/style>/g, "");
  html = html.replace(/\s*<script data-dashboard-ui>[\s\S]*?<\/script>/g, "");
  html = html.replace(/\s*<script data-service-matching>[\s\S]*?<\/script>/g, "");
  html = html.replace(/`r`n/g, "\n");
  const pageStyles = join(root, "frontend", `${page}.css`);
  const styles = existsSync(pageStyles) ? `${css}\n\n${readFileSync(pageStyles, "utf8").trim()}` : css;
  html = html.replace("</head>", `  <style data-dashboard-styles>\n${styles}\n  </style>\n</head>`);
  html = html.replace("</main>", `</main>\n  <script data-dashboard-ui>\n${ui}\n  </script>`);
  if (["service-messages", "recent-orders"].includes(page)) {
    // Include the existing matcher with the page. Older running servers may not
    // expose its separate asset route, while they already serve this HTML file.
    const matcher = readFileSync(join(root, "service-matching.js"), "utf8").trim();
    html = html.replace(/\s*<script src="\/service-matching\.js" defer><\/script>/g, "");
    html = html.replace('  <script src="/api-client.js"', () => `  <script data-service-matching>\n${matcher}\n  </script>\n  <script src="/api-client.js"`);
  }
  writeFileSync(file, html.trimEnd() + "\n");
}
console.log(`Updated styles and interactions in ${targetPages.length} pages.`);
