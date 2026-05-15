// Minimal Playwright script: open the spike app and wait for the auto-unmount cycle.
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

const errors: string[] = [];
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(msg.text());
});

const port = process.env.VITE_PORT ?? "5173";
await page.goto(`http://localhost:${port}`, { waitUntil: "networkidle" });
// App auto-unmounts after 800ms; we wait 2000ms to ensure WS has time to deliver frames.
await page.waitForTimeout(2000);
await browser.close();

if (errors.length) {
  console.error("Browser errors:", errors);
  process.exit(1);
}
process.exit(0);
