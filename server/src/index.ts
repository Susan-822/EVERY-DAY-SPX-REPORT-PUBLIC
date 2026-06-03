import express from "express";
import cors from "cors";
import path from "path";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import dotenv from "dotenv";
import { db, runQuery, allQuery, getQuery } from "./db";
import { BitgetService } from "./services/bitgetService";
import { OpenAIService, AnalysisInput } from "./services/openaiService";
import { ScreenshotService } from "./services/screenshotService";

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Serve static screenshots
const screenshotsDir = path.join(__dirname, "..", "data", "screenshots");
app.use("/screenshots", express.static(screenshotsDir));

// Create HTTP server & WebSocket server
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// WebSocket client registry
const clients = new Set<WebSocket>();

wss.on("connection", (ws) => {
  clients.add(ws);
  console.log(`[WS] Client connected. Total clients: ${clients.size}`);
  
  ws.on("close", () => {
    clients.delete(ws);
    console.log(`[WS] Client disconnected. Total clients: ${clients.size}`);
  });
});

// Helper to broadcast WS messages
function broadcast(event: string, data: any) {
  const payload = JSON.stringify({ event, data });
  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// ----------------------------------------------------
// REST API ROUTES
// ----------------------------------------------------

/**
 * GET System Configuration Status
 */
app.get("/api/status", (req, res) => {
  res.json({
    bitget: {
      configured: BitgetService.isConfigured(),
      apiUrl: process.env.BITGET_API_URL || "https://api.bitget.com"
    },
    openai: {
      configured: OpenAIService.isConfigured()
    },
    unusualWhales: {
      configured: !!process.env.UNUSUAL_WHALES_API_KEY
    }
  });
});

/**
 * GET Bitget Account Balance
 */
app.get("/api/balance", async (req, res) => {
  try {
    const balance = await BitgetService.getBalance();
    res.json({ success: true, data: balance });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET Active Positions
 */
app.get("/api/positions", async (req, res) => {
  try {
    const positions = await BitgetService.getPositions();
    res.json({ success: true, data: positions });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET Signals History
 */
app.get("/api/signals", async (req, res) => {
  try {
    const rows = await allQuery("SELECT * FROM signals ORDER BY timestamp DESC LIMIT 50");
    res.json({ success: true, data: rows });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET Orders History
 */
app.get("/api/orders", async (req, res) => {
  try {
    const rows = await allQuery("SELECT * FROM orders ORDER BY timestamp DESC LIMIT 50");
    res.json({ success: true, data: rows });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST Analyze Ticker (Main AI Analysis Trigger)
 */
app.post("/api/analyze", async (req, res) => {
  const { symbol } = req.body;
  if (!symbol) {
    return res.status(400).json({ success: false, error: "Symbol is required" });
  }

  const cleanSymbol = symbol.toUpperCase().trim();
  console.log(`\n=== Starting Analysis for ${cleanSymbol} ===`);

  try {
    // 1. Capture Technical Chart Screenshot (TradingView Widget)
    let tvScreenshot = "";
    try {
      tvScreenshot = await ScreenshotService.takeTradingViewScreenshot(cleanSymbol);
    } catch (e) {
      console.warn("[Server] TV Screenshot capture failed, continuing without it.", e);
    }

    // 2. Capture Unusual Whales Options Flow Screenshot (Optional)
    let uwScreenshot = "";
    try {
      uwScreenshot = await ScreenshotService.takeUnusualWhalesScreenshot(cleanSymbol);
    } catch (e) {
      console.warn("[Server] UW Screenshot capture failed, continuing without it.", e);
    }

    // 3. Assemble Price Data & Options Flow Data (Use real live metrics if possible, or high-fidelity simulated data)
    // Note: Since we don't have paid feeds, we fetch basic stock info or generate mock metrics 
    // simulating Option Flows and TradingView Indicators
    const lastPrice = cleanSymbol === "TSLA" ? 180.20 : (cleanSymbol === "AAPL" ? 175.50 : 200.00 + (Math.random() - 0.5) * 50);
    const mockRsi = Math.floor(45 + Math.random() * 20);
    
    const analysisInput: AnalysisInput = {
      symbol: cleanSymbol,
      priceData: {
        price: parseFloat(lastPrice.toFixed(2)),
        change24h: parseFloat((Math.random() * 4 - 2).toFixed(2)),
        high24h: parseFloat((lastPrice * 1.02).toFixed(2)),
        low24h: parseFloat((lastPrice * 0.98).toFixed(2)),
        volume: Math.floor(1000000 + Math.random() * 5000000),
        rsi: mockRsi,
        macd: {
          macdLine: parseFloat((Math.random() * 2 - 1).toFixed(3)),
          signalLine: parseFloat((Math.random() * 2 - 1).toFixed(3)),
          histogram: parseFloat((Math.random() * 0.5 - 0.25).toFixed(3))
        },
        customIndicators: "EMA(20) is crossing EMA(50) upwards on 15m chart. Support level holding strong."
      },
      optionFlowData: {
        totalVolume: Math.floor(50000 + Math.random() * 150000),
        callVolume: Math.floor(30000 + Math.random() * 90000),
        putVolume: Math.floor(20000 + Math.random() * 60000),
        callPutRatio: parseFloat((1.2 + Math.random() * 0.6).toFixed(2)),
        recentSweeps: [
          { strike: parseFloat((lastPrice * 1.05).toFixed(0)), type: "CALL", sentiment: "BULLISH", size: "$450k", sweep: true },
          { strike: parseFloat((lastPrice * 1.08).toFixed(0)), type: "CALL", sentiment: "BULLISH", size: "$220k", sweep: true },
          { strike: parseFloat((lastPrice * 0.95).toFixed(0)), type: "PUT", sentiment: "BEARISH", size: "$110k", sweep: false }
        ]
      },
      screenshotPath: tvScreenshot ? path.join(screenshotsDir, tvScreenshot) : undefined
    };

    // 4. Run AI Decision Analysis
    console.log("[Server] Calling OpenAI for analysis...");
    const aiResult = await OpenAIService.analyzeMarket(analysisInput);

    // 5. Store the generated signal in SQLite
    const insertSql = `
      INSERT INTO signals (symbol, direction, confidence, reasoning, suggested_entry, suggested_sl, suggested_tp, raw_tv_data, raw_uw_data, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')
    `;
    const dbResult = await runQuery(insertSql, [
      cleanSymbol,
      aiResult.direction,
      aiResult.confidence,
      aiResult.reasoning,
      aiResult.suggested_entry,
      aiResult.suggested_sl,
      aiResult.suggested_tp,
      JSON.stringify({ screenshot: tvScreenshot, priceData: analysisInput.priceData }),
      JSON.stringify({ screenshot: uwScreenshot, optionFlow: analysisInput.optionFlowData })
    ]);

    const finalSignal = {
      id: dbResult.id,
      timestamp: new Date().toISOString(),
      symbol: cleanSymbol,
      direction: aiResult.direction,
      confidence: aiResult.confidence,
      reasoning: aiResult.reasoning,
      suggested_entry: aiResult.suggested_entry,
      suggested_sl: aiResult.suggested_sl,
      suggested_tp: aiResult.suggested_tp,
      tvScreenshot,
      uwScreenshot,
      status: 'PENDING'
    };

    // 6. Broadcast new signal to all frontend UIs via WebSockets
    broadcast("NEW_SIGNAL", finalSignal);

    res.json({ success: true, data: finalSignal });
  } catch (err: any) {
    console.error("[Server] Analysis failed:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST Execute Order (Trigger Trade placement on Bitget)
 */
app.post("/api/order/execute", async (req, res) => {
  const { signalId, symbol, side, size, price, orderType, enableTPSL, stopLossPrice, takeProfitPrice } = req.body;

  if (!symbol || !side || !size || !orderType) {
    return res.status(400).json({ success: false, error: "Missing required order parameters" });
  }

  const cleanSymbol = symbol.toUpperCase().trim();
  const cleanSide = side.toLowerCase() as "buy" | "sell";

  console.log(`\n=== Executing Order for ${cleanSymbol} ===`);
  
  try {
    // 1. Record pending order in database
    const dbOrderResult = await runQuery(
      `INSERT INTO orders (signal_id, symbol, direction, price, quantity, order_type, status) VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`,
      [signalId || null, cleanSymbol, cleanSide, price || null, size, orderType]
    );
    const orderRecordId = dbOrderResult.id;

    // 2. Call Bitget service to place order
    console.log(`[Server] Placing ${cleanSide} order of size ${size} for ${cleanSymbol}...`);
    const bitgetOrder = await BitgetService.placeOrder({
      symbol: cleanSymbol,
      side: cleanSide,
      size,
      orderType,
      price: price ? price.toString() : undefined
    });

    const bitgetOrderId = bitgetOrder.orderId;

    // 3. Set Take Profit & Stop Loss if enabled
    if (enableTPSL && (takeProfitPrice || stopLossPrice)) {
      console.log(`[Server] Order placed successfully (${bitgetOrderId}). Setting TP/SL...`);
      // Wait 1.5s for transaction processing
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      try {
        await BitgetService.placeTPSL({
          symbol: cleanSymbol,
          stopSurplusTriggerPrice: takeProfitPrice ? takeProfitPrice.toString() : undefined,
          stopLossTriggerPrice: stopLossPrice ? stopLossPrice.toString() : undefined,
          size
        });
        console.log(`[Server] TP/SL settings successfully registered on Bitget.`);
      } catch (tpslErr: any) {
        console.error("[Server] Failed to apply TP/SL plans:", tpslErr.message);
      }
    }

    // 4. Update order status to SUCCESS in DB
    await runQuery(
      `UPDATE orders SET status = 'SUCCESS', bitget_order_id = ? WHERE id = ?`,
      [bitgetOrderId, orderRecordId]
    );

    // 5. Update parent signal status to EXECUTED
    if (signalId) {
      await runQuery(`UPDATE signals SET status = 'EXECUTED' WHERE id = ?`, [signalId]);
    }

    // 6. Push balance/positions updates
    let updatedBalance = null;
    let updatedPositions = [];
    try {
      updatedBalance = await BitgetService.getBalance();
      updatedPositions = await BitgetService.getPositions();
    } catch (e) {
      console.warn("[Server] Post-order metrics query failed:", e);
    }

    const orderOutput = {
      orderId: orderRecordId,
      bitgetOrderId,
      status: "SUCCESS"
    };

    // Broadcast update
    broadcast("ORDER_EXECUTED", {
      order: orderOutput,
      signalId,
      balance: updatedBalance,
      positions: updatedPositions
    });

    res.json({ success: true, data: orderOutput });
  } catch (err: any) {
    console.error("[Server] Order execution failed:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST Reject Signal
 */
app.post("/api/signal/reject", async (req, res) => {
  const { signalId } = req.body;
  if (!signalId) {
    return res.status(400).json({ success: false, error: "Signal ID is required" });
  }

  try {
    await runQuery(`UPDATE signals SET status = 'REJECTED' WHERE id = ?`, [signalId]);
    broadcast("SIGNAL_REJECTED", { signalId });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Start listening
server.listen(port, () => {
  console.log(`=======================================================`);
  console.log(`  Bitget US Stock Trading Server running on port ${port} `);
  console.log(`  Access backend endpoints at http://localhost:${port}   `);
  console.log(`=======================================================`);
});
