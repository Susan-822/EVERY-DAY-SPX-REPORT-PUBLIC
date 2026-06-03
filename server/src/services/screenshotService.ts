import { chromium, BrowserContext } from "playwright";
import path from "path";
import fs from "fs";

const SCREENSHOTS_DIR = path.join(__dirname, "..", "..", "data", "screenshots");
const USER_DATA_DIR = path.join(__dirname, "..", "..", "data", "browser_session");

// Ensure directories exist
if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}
if (!fs.existsSync(USER_DATA_DIR)) {
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
}

export class ScreenshotService {
  /**
   * Capture a clean TradingView chart screenshot using widget embed
   */
  static async takeTradingViewScreenshot(symbol: string): Promise<string> {
    const formattedSymbol = symbol.toUpperCase().includes("USDT")
      ? symbol.replace("USDT", "")
      : symbol;
    
    // TradingView widget uses NASDAQ:TSLA or NYSE:BABA format.
    // For general stocks, we'll try to default to NASDAQ or NYSE. 
    // Usually, s.tradingview.com/widgetembed accepts SYMBOL directly, or with exchange prefix.
    const url = `https://s.tradingview.com/widgetembed/?symbol=${formattedSymbol}&interval=15&theme=dark&style=1&timezone=Exchange&studies=%5B%5D`;

    console.log(`[Screenshot Service] Capturing TradingView chart from: ${url}`);
    
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setViewportSize({ width: 1000, height: 600 });
      
      // Navigate and wait for content
      await page.goto(url, { waitUntil: "networkidle" });
      
      // Wait a few seconds for charts to render animation/draw
      await page.waitForTimeout(3000);
      
      const fileName = `${formattedSymbol.toLowerCase()}_tv_${Date.now()}.png`;
      const filePath = path.join(SCREENSHOTS_DIR, fileName);
      
      await page.screenshot({ path: filePath, fullPage: true });
      console.log(`[Screenshot Service] Saved TradingView screenshot to: ${filePath}`);
      
      // Clean up older screenshots for this symbol
      this.cleanupOldScreenshots(formattedSymbol, "tv", fileName);

      return fileName;
    } catch (err) {
      console.error("[Screenshot Service] TradingView capture failed:", err);
      throw err;
    } finally {
      await browser.close();
    }
  }

  /**
   * Capture Unusual Whales Flow / Stock Details Page
   * If persistent login exists, it will use it. Otherwise, it will capture the public page.
   */
  static async takeUnusualWhalesScreenshot(symbol: string): Promise<string> {
    const formattedSymbol = symbol.toUpperCase().includes("USDT")
      ? symbol.replace("USDT", "")
      : symbol;

    const url = `https://unusualwhales.com/stock/${formattedSymbol}/flow`;
    console.log(`[Screenshot Service] Capturing Unusual Whales Flow from: ${url}`);

    let context: BrowserContext;
    let isPersistent = false;

    // Check if we have active user session directory
    try {
      context = await chromium.launchPersistentContext(USER_DATA_DIR, {
        headless: true,
        viewport: { width: 1200, height: 800 }
      });
      isPersistent = true;
    } catch (err) {
      console.log("[Screenshot Service] Launching normal headful context (no persistent context found or locked).");
      const browser = await chromium.launch({ headless: true });
      context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    }

    try {
      const page = await context.newPage();
      
      // Unusual Whales is protected by Cloudflare. Let's wait longer and set a realistic user agent
      await page.setExtraHTTPHeaders({
        "Accept-Language": "en-US,en;q=0.9"
      });
      
      await page.goto(url, { waitUntil: "load", timeout: 30000 });
      
      // Wait for content (e.g. options flow table, charts) to load
      await page.waitForTimeout(5000);

      const fileName = `${formattedSymbol.toLowerCase()}_uw_${Date.now()}.png`;
      const filePath = path.join(SCREENSHOTS_DIR, fileName);
      
      await page.screenshot({ path: filePath, fullPage: false });
      console.log(`[Screenshot Service] Saved Unusual Whales screenshot to: ${filePath}`);
      
      // Clean up older screenshots
      this.cleanupOldScreenshots(formattedSymbol, "uw", fileName);

      return fileName;
    } catch (err) {
      console.error("[Screenshot Service] Unusual Whales capture failed:", err);
      // Return a placeholder or empty string
      return "";
    } finally {
      await context.close();
    }
  }

  /**
   * Helper to clean up older screenshots of the same symbol to save space
   */
  private static cleanupOldScreenshots(symbol: string, type: "tv" | "uw", currentFileName: string) {
    try {
      const prefix = `${symbol.toLowerCase()}_${type}_`;
      const files = fs.readdirSync(SCREENSHOTS_DIR);
      for (const file of files) {
        if (file.startsWith(prefix) && file !== currentFileName) {
          fs.unlinkSync(path.join(SCREENSHOTS_DIR, file));
        }
      }
    } catch (err) {
      console.error("[Screenshot Service] Error cleaning up old screenshots:", err);
    }
  }
}
