import fs from "fs";
import path from "path";

const JSON_PATH = path.join(__dirname, "..", "..", "data", "uw", "latest-candidates.json");

// Ensure folder exists
const dir = path.dirname(JSON_PATH);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

export interface OptionFlowItem {
  timestamp: number; // UTC Epoch ms
  strike: number;
  type: "CALL" | "PUT";
  sentiment: "BULLISH" | "BEARISH" | "NEUTRAL";
  premium: number; // clean value in USD
  sweep: boolean;
}

export interface CandidateStock {
  symbol: string;
  score: number; // 0 to 100
  recentFlows: OptionFlowItem[];
  volatilityExpected: number; // IV or historical proxy
  netPremiumDirection: "BULLISH" | "BEARISH" | "NEUTRAL";
}

export class CandidateEngine {
  /**
   * Cleans and evaluates Unusual Whales flows, generating the scored candidate list
   */
  static async refreshCandidates(mockFlows: { [symbol: string]: OptionFlowItem[] } = {}): Promise<CandidateStock[]> {
    console.log("[Candidate Engine] Analyzing Unusual Whales option flows and GEX...");
    const now = Date.now();
    const candidates: CandidateStock[] = [];

    // Tickers we support
    const symbols = [
      "NVDA", "TSLA", "AAPL", "MSFT", "META", 
      "AMZN", "GOOGL", "AMD", "AVGO", "NFLX", 
      "SPY", "QQQ"
    ];

    for (const symbol of symbols) {
      // Fetch or use mock flows
      const rawFlows = mockFlows[symbol] || this.generateMockUWSweeps(symbol);
      
      // Clean and Filter options flow based on the strict time rules
      const cleanedFlows: OptionFlowItem[] = [];
      let totalBullishPremium = 0;
      let totalBearishPremium = 0;

      for (const flow of rawFlows) {
        const ageMinutes = (now - flow.timestamp) / 1000 / 60;
        
        // 1. HARD RULE: Ignore flows older than 15 minutes
        if (ageMinutes > 15) {
          continue; 
        }

        // Clean premium formats (e.g. converting numeric types or format strings)
        const cleanPremium = Number(flow.premium);
        
        const cleanedFlow: OptionFlowItem = {
          ...flow,
          premium: cleanPremium
        };
        cleanedFlows.push(cleanedFlow);

        // Net premium computation
        if (flow.sentiment === "BULLISH") {
          totalBullishPremium += cleanPremium;
        } else if (flow.sentiment === "BEARISH") {
          totalBearishPremium += cleanPremium;
        }
      }

      // Check if candidate has fresh flow under 5 minutes
      const hasFreshTrigger = cleanedFlows.some(
        f => (now - f.timestamp) / 1000 / 60 <= 5
      );

      // Score the symbol (incorporating Bitget volume checks, GEX, and flows freshness)
      let score = 0;
      if (cleanedFlows.length > 0) {
        // High premium sweeps add more weight
        const totalPremium = totalBullishPremium + totalBearishPremium;
        score += Math.min(40, Math.floor(totalPremium / 50000));
        
        // Directional alignment score
        const ratio = totalPremium > 0 ? Math.max(totalBullishPremium, totalBearishPremium) / totalPremium : 0.5;
        score += Math.floor(ratio * 30);

        // Freshness trigger bonus
        if (hasFreshTrigger) {
          score += 30; // +30 points for fresh flows under 5 mins
        }
      }

      let netPremiumDirection: "BULLISH" | "BEARISH" | "NEUTRAL" = "NEUTRAL";
      if (totalBullishPremium > totalBearishPremium * 1.5) netPremiumDirection = "BULLISH";
      else if (totalBearishPremium > totalBullishPremium * 1.5) netPremiumDirection = "BEARISH";

      candidates.push({
        symbol,
        score,
        recentFlows: cleanedFlows,
        volatilityExpected: 0.35 + Math.random() * 0.15,
        netPremiumDirection
      });
    }

    // Sort and keep only the top 3 highest scoring candidate stocks
    const topCandidates = candidates
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    // Save to JSON
    fs.writeFileSync(JSON_PATH, JSON.stringify(topCandidates, null, 2), "utf-8");
    console.log(`[Candidate Engine] Saved candidates list to: ${JSON_PATH}`);
    return topCandidates;
  }

  /**
   * Helper to fetch cached candidates list
   */
  static getCachedCandidates(): CandidateStock[] {
    if (fs.existsSync(JSON_PATH)) {
      try {
        return JSON.parse(fs.readFileSync(JSON_PATH, "utf-8"));
      } catch (e) {
        return [];
      }
    }
    return [];
  }

  /**
   * Helper to generate fresh simulated sweeps for Unusual Whales sandbox testing
   */
  private static generateMockUWSweeps(symbol: string): OptionFlowItem[] {
    const now = Date.now();
    const flows: OptionFlowItem[] = [];

    // Generates 3-5 sweeps with randomized timestamps
    const count = 3 + Math.floor(Math.random() * 3);
    const sentiment = Math.random() > 0.4 ? "BULLISH" : "BEARISH";

    for (let i = 0; i < count; i++) {
      // Distribute timestamps: some fresh (under 5 mins), some background (5-15 mins)
      const ageMs = i === 0 
        ? Math.random() * 4 * 60 * 1000 // guaranteed fresh (< 5 mins)
        : (5 + Math.random() * 8) * 60 * 1000; // background (5-13 mins)
      
      flows.push({
        timestamp: now - ageMs,
        strike: 150 + Math.floor(Math.random() * 100),
        type: sentiment === "BULLISH" ? "CALL" : "PUT",
        sentiment: sentiment,
        premium: 50000 + Math.floor(Math.random() * 400000),
        sweep: Math.random() > 0.3
      });
    }

    return flows;
  }
}
