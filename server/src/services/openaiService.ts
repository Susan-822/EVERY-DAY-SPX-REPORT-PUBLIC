import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const isConfigured = !!OPENAI_API_KEY;

export interface AnalysisInput {
  symbol: string;
  priceData: {
    price: number;
    change24h: number;
    high24h: number;
    low24h: number;
    volume: number;
    rsi?: number;
    macd?: { macdLine: number; signalLine: number; histogram: number };
    customIndicators?: string;
  };
  optionFlowData?: {
    totalVolume: number;
    callVolume: number;
    putVolume: number;
    callPutRatio: number;
    recentSweeps: any[];
  };
  screenshotPath?: string; // Optional path to TradingView/UW screenshot
}

export interface AnalysisResult {
  symbol: string;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  confidence: number; // 0 to 1
  signal_grade: "B" | "A" | "A+" | "S" | "C"; // C is Do Not Trade
  reasoning: string;
  suggested_entry: number;
  suggested_sl: number;
  suggested_tp: number;
}

export class OpenAIService {
  static isConfigured(): boolean {
    return isConfigured;
  }

  /**
   * Run trading decision analysis using GPT-4o multimodal model with Signal Grading
   */
  static async analyzeMarket(input: AnalysisInput): Promise<AnalysisResult> {
    if (!isConfigured) {
      console.log("[OpenAI Service] API Key not configured. Using Mock Analysis.");
      // Return a simulated mock graded analysis
      const direction = Math.random() > 0.55 ? "LONG" : (Math.random() > 0.5 ? "SHORT" : "NEUTRAL");
      const currentPrice = input.priceData.price;
      const grades: ("B" | "A" | "A+" | "S" | "C")[] = ["B", "A", "A+", "S"];
      const signal_grade = direction === "NEUTRAL" ? "C" : grades[Math.floor(Math.random() * grades.length)];
      
      return {
        symbol: input.symbol,
        direction,
        confidence: parseFloat((0.6 + Math.random() * 0.35).toFixed(2)),
        signal_grade,
        reasoning: `[MOCK ANALYSIS] Graded analysis for ${input.symbol}. Price is currently at $${currentPrice}. Option sweeps indicate institutional flow is aligned. Technical setup shows support hold. Graded as ${signal_grade} class signal based on entry proximity and flow alignment.`,
        suggested_entry: parseFloat(currentPrice.toFixed(2)),
        suggested_sl: parseFloat((direction === "LONG" ? currentPrice * 0.97 : currentPrice * 1.03).toFixed(2)), // tight SL
        suggested_tp: parseFloat((direction === "LONG" ? currentPrice * 1.05 : currentPrice * 0.95).toFixed(2)),
      };
    }

    try {
      const messages: any[] = [];
      
      const systemPrompt = `You are a professional derivatives trader specializing in US stocks. 
You will be provided with technical indicators, option flows, and K-line chart screenshots.
Analyze the data and determine if there's a trading opportunity. Grade the opportunity strictly based on these rules:

- C-Grade (Do Not Trade): Opportunities that do not meet standard parameters or look chaotic.
- B-Grade (Leverage 3-5x): Unusual Whales has option activity but price structure or trend is not clean, or price is at a key level but has not shown reaction yet.
- A-Grade (Leverage 8-12x): Price is at key support/resistance, option flows support the direction, order book is normal, no major economic event risks, stop loss is clear and tight.
- A+ Grade (Leverage 15-20x): Strong trend, price is exactly at key entry level, continuous sweep order flows, close stop loss, risk-reward ratio is at least 1.5R - 2R.
- S-Grade (Leverage 20-25x): Rare. High volatility stock, clean trend, price is exactly at key breakout/pullback point, massive institutional sweeps in the same direction, no opposite orderbook blocks, very tight stop loss.

Your response MUST be in JSON format conforming to this schema:
{
  "symbol": "string (e.g. TSLA)",
  "direction": "LONG" | "SHORT" | "NEUTRAL",
  "confidence": number (0.0 to 1.0),
  "signal_grade": "B" | "A" | "A+" | "S" | "C",
  "reasoning": "string (detailed technical, chart structure, and flow reasoning)",
  "suggested_entry": number,
  "suggested_sl": number,
  "suggested_tp": number
}`;

      messages.push({ role: "system", content: systemPrompt });

      const userContent: any[] = [
        {
          type: "text",
          text: `Please analyze the following market data for ticker ${input.symbol}:
          
--- Technical Indicators & Price Action ---
- Last Price: $${input.priceData.price}
- 24h Change: ${input.priceData.change24h}%
- 24h High/Low: $${input.priceData.high24h} / $${input.priceData.low24h}
- Volume: ${input.priceData.volume}
- RSI (14): ${input.priceData.rsi || "N/A"}
- MACD: ${input.priceData.macd ? `MACD Line: ${input.priceData.macd.macdLine}, Signal: ${input.priceData.macd.signalLine}, Hist: ${input.priceData.macd.histogram}` : "N/A"}
${input.priceData.customIndicators ? `- Custom technicals: ${input.priceData.customIndicators}` : ""}

--- Unusual Whales Options Flow ---
${input.optionFlowData ? `
- Total Option Volume: ${input.optionFlowData.totalVolume}
- Call Volume / Put Volume: ${input.optionFlowData.callVolume} / ${input.optionFlowData.putVolume}
- Call/Put Ratio: ${input.optionFlowData.callPutRatio}
- Recent sweeps: ${JSON.stringify(input.optionFlowData.recentSweeps)}
` : "No option flow data available."}
          `
        }
      ];

      // Convert screenshot to base64 if available
      if (input.screenshotPath && fs.existsSync(input.screenshotPath)) {
        console.log(`[OpenAI Service] Attaching chart screenshot to OpenAI request: ${input.screenshotPath}`);
        const imageBuffer = fs.readFileSync(input.screenshotPath);
        const base64Image = imageBuffer.toString("base64");
        
        userContent.push({
          type: "image_url",
          image_url: {
            url: `data:image/png;base64,${base64Image}`
          }
        });
      }

      messages.push({ role: "user", content: userContent });

      console.log(`[OpenAI Service] Sending request to OpenAI API...`);
      const response = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: "gpt-4o",
          messages: messages,
          response_format: { type: "json_object" },
          temperature: 0.2
        },
        {
          headers: {
            "Authorization": `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json"
          }
        }
      );

      const responseText = response.data.choices[0].message.content;
      console.log(`[OpenAI Service] OpenAI Graded Response received:`, responseText);
      
      const result: AnalysisResult = JSON.parse(responseText);
      return result;
    } catch (err: any) {
      console.error("[OpenAI Service] Error analyzing market:", err.response?.data || err.message);
      throw err;
    }
  }
}
