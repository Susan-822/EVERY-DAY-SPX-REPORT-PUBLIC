const { chromium } = require("playwright");
const path = require("path");
const readline = require("readline");

const USER_DATA_DIR = path.join(__dirname, "data", "browser_session");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

async function main() {
  console.log("------------------------------------------------------------------");
  console.log("Unusual Whales Persistent Login Helper");
  console.log("------------------------------------------------------------------");
  console.log("This script will open a headful Chromium browser window.");
  console.log("Please log in to Unusual Whales inside the opened browser.");
  console.log("Once you have successfully logged in and can see your dashboard,");
  console.log("come back to this terminal and press [ENTER] to save the session.");
  console.log("------------------------------------------------------------------\n");

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 }
  });

  const page = await context.newPage();
  
  try {
    await page.goto("https://unusualwhales.com/login", { waitUntil: "load" });
    
    rl.question("👉 Are you logged in? Press [ENTER] in this terminal to save session and close browser: ", async () => {
      console.log("\nSaving session cookies and closing browser...");
      await context.close();
      console.log("✅ Session saved successfully! Playwright can now take logged-in screenshots in headless mode.");
      rl.close();
      process.exit(0);
    });

  } catch (err) {
    console.error("An error occurred during browser run:", err);
    await context.close();
    rl.close();
  }
}

main();
