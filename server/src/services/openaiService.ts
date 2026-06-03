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
   * Run trading decision analysis using GPT-4o multimodal model
   */
  static async analyzeMarket(input: AnalysisInput): Promise<AnalysisResult> {
    if (!isConfigured) {
      console.log("[OpenAI Service] API Key not configured. Using Mock Analysis.");
      // Return a simulated mock analysis
      const direction = Math.random() > 0.55 ? "LONG" : (Math.random() > 0.5 ? "SHORT" : "NEUTRAL");
      const currentPrice = input.priceData.price;
      return {
        symbol: input.symbol,
        direction,
        confidence: parseFloat((0.6 + Math.random() * 0.35).toFixed(2)),
        reasoning: `[MOCK ANALYSIS] TradingView indicators for ${input.symbol} show a bullish price action with RSI at ${input.priceData.rsi || 52}. Unusual Whales option flow indicates active Sweep buys on near-term Call options. Standard support level holds at $${(currentPrice * 0.97).toFixed(2)}.`,
        suggested_entry: parseFloat(currentPrice.toFixed(2)),
        suggested_sl: parseFloat((direction === "LONG" ? currentPrice * 0.95 : currentPrice * 1.05).toFixed(2)),
        suggested_tp: parseFloat((direction === "LONG" ? currentPrice * 1.10 : currentPrice * 0.90).toFixed(2)),
      };
    }

    try {
      const messages: any[] = [];
      
      const systemPrompt = `You are a professional derivatives trader specializing in US stocks. 
You will be provided with current technical indicators and option flow details. 
Analyze the data and determine if there's a trading opportunity.
Your response MUST be in JSON format conforming to this schema:
{
  "symbol": "string (the ticker, e.g. TSLA)",
  "direction": "LONG" | "SHORT" | "NEUTRAL",
  "confidence": number (0.0 to 1.0 representing confidence in this trade),
  "reasoning": "string (detailed analysis of price, technicals, option flows, support/resistance)",
  "suggested_entry": number (suggested entry price),
  "suggested_sl": number (suggested stop loss price),
  "suggested_tp": number (suggested take profit price)
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

      // If a screenshot is available, convert to base64 and add to message
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
      console.log(`[OpenAI Service] OpenAI Response received:`, responseText);
      
      const result: AnalysisResult = JSON.parse(responseText);
      return result;
    } catch (err: any) {
      console.error("[OpenAI Service] Error analyzing market:", err.response?.data || err.message);
      throw err;
    }
  }
}
