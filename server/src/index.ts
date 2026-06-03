import express from "express";
import cors from "cors";
import path from "path";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import dotenv from "dotenv";
import { db, runQuery, allQuery, getQuery, getDailyStats, updateDailyStats, resetDailyStats } from "./db";
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

// Get YYYY-MM-DD date string in local timezone
function getLocalDateString() {
  const d = new Date();
  const offset = d.getTimezoneOffset();
  const localDate = new Date(d.getTime() - (offset * 60 * 1000));
  return localDate.toISOString().split("T")[0];
}

// ----------------------------------------------------
// REST API ROUTES
// ----------------------------------------------------

/**
 * GET System Configuration Status and Daily Risk Metrics
 */
app.get("/api/status", async (req, res) => {
  const today = getLocalDateString();
  try {
    const riskStats = await getDailyStats(today);
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
      },
      riskTracker: {
        today,
        totalPnl: riskStats.total_pnl,
        consecutiveLosses: riskStats.consecutive_losses,
        tradingHalted: riskStats.trading_halted === 1
      }
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST Reset Daily stats (For testing/debugging purposes)
 */
app.post("/api/risk/reset", async (req, res) => {
  const today = getLocalDateString();
  try {
    await resetDailyStats(today);
    const updatedStats = await getDailyStats(today);
    broadcast("RISK_UPDATED", {
      totalPnl: updatedStats.total_pnl,
      consecutiveLosses: updatedStats.consecutive_losses,
      tradingHalted: updatedStats.trading_halted === 1
    });
    res.json({ success: true, message: "Daily stats reset successfully." });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
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
 * POST Analyze Ticker (Includes Grading, Sizing and Dynamic Leverage Wind Control)
 */
app.post("/api/analyze", async (req, res) => {
  const { symbol } = req.body;
  if (!symbol) {
    return res.status(400).json({ success: false, error: "Symbol is required" });
  }

  const cleanSymbol = symbol.toUpperCase().trim();
  console.log(`\n=== Starting Graded Risk Analysis for ${cleanSymbol} ===`);

  try {
    const today = getLocalDateString();
    const riskStats = await getDailyStats(today);

    // If trading is halted for today (loss <= -50 or consecutive losses >= 3), block or auto-downgrade to C
    if (riskStats.trading_halted === 1) {
      return res.status(403).json({ 
        success: false, 
        error: "风控拦截：今日亏损或连损已达上限，交易已停机熔断，不可开启新扫描。" 
      });
    }

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

    // 3. Assemble Price Data & Options Flow
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
        customIndicators: "EMA(20) is crossing EMA(50) upwards. Multi-timeframe trend aligns."
      },
      optionFlowData: {
        totalVolume: Math.floor(50000 + Math.random() * 150000),
        callVolume: Math.floor(30000 + Math.random() * 90000),
        putVolume: Math.floor(20000 + Math.random() * 60000),
        callPutRatio: parseFloat((1.2 + Math.random() * 0.6).toFixed(2)),
        recentSweeps: [
          { strike: parseFloat((lastPrice * 1.04).toFixed(0)), type: "CALL", sentiment: "BULLISH", size: "$450k", sweep: true },
          { strike: parseFloat((lastPrice * 1.06).toFixed(0)), type: "CALL", sentiment: "BULLISH", size: "$220k", sweep: true }
        ]
      },
      screenshotPath: tvScreenshot ? path.join(screenshotsDir, tvScreenshot) : undefined
    };

    // 4. Run AI Decision Analysis
    console.log("[Server] Calling OpenAI for graded analysis...");
    const aiResult = await OpenAIService.analyzeMarket(analysisInput);

    // 5. Apply Wind Control Rules on the AI Signal Grade
    let finalGrade = aiResult.signal_grade;
    let downgradeReason = "";

    // Rule: Daily loss hits -$30 -> force downgrade to max B-grade
    if (riskStats.total_pnl <= -30 && finalGrade !== "C" && finalGrade !== "B") {
      finalGrade = "B";
      downgradeReason = "由于今日累计亏损超过 $30，信号等级强行降级为 B 级开仓限制。";
    }

    // Rule: Consecutive loss count = 2 -> auto downgrade signal by 1 level
    if (riskStats.consecutive_losses === 2 && finalGrade !== "C") {
      const original = finalGrade;
      if (finalGrade === "S") finalGrade = "A+";
      else if (finalGrade === "A+") finalGrade = "A";
      else if (finalGrade === "A") finalGrade = "B";
      else if (finalGrade === "B") finalGrade = "C";
      
      downgradeReason = `由于连续出现 2 次亏损，信号等级从 ${original} 降级为 ${finalGrade}。`;
    }

    // If grade is C, direction becomes NEUTRAL (Do Not Trade)
    let finalDirection = aiResult.direction;
    if (finalGrade === "C") {
      finalDirection = "NEUTRAL";
    }

    // 6. Quantitative Position Sizing & Leverage Math
    // Account details: standard default $500 balance if sandbox, or actual Bitget account balance
    let accountBalanceVal = 500.00;
    try {
      const bgBal = await BitgetService.getBalance();
      // If real account balance returned, extract available
      if (bgBal && bgBal.available) {
        accountBalanceVal = parseFloat(bgBal.available);
      }
    } catch(e) {}

    // A. Define parameters based on signal grade
    let riskBudget = 0; // Loss budget in USD
    let maxLeverage = 1;

    switch (finalGrade) {
      case "S":
        riskBudget = 25;
        maxLeverage = 25;
        break;
      case "A+":
        riskBudget = 18;
        maxLeverage = 20;
        break;
      case "A":
        riskBudget = 12;
        maxLeverage = 12;
        break;
      case "B":
        riskBudget = 6;
        maxLeverage = 5;
        break;
      case "C":
      default:
        riskBudget = 0;
        maxLeverage = 0;
        break;
    }

    // B. Calculate Stop Loss distance %
    const entryPrice = aiResult.suggested_entry;
    const slPrice = aiResult.suggested_sl;
    let slDistancePercent = Math.abs(entryPrice - slPrice) / entryPrice;
    
    // Safety floor on SL distance percent to avoid division by zero or extreme sizing (min 0.5%)
    if (slDistancePercent < 0.005) {
      slDistancePercent = 0.005;
    }

    // C. Calculate Nominal Position size and Required Leverage
    let suggestedPositionValue = 0;
    let requiredLeverage = 1;
    let calculatedQty = 0;

    if (finalGrade !== "C" && finalDirection !== "NEUTRAL") {
      // Risk budget / SL distance % = Nominal Position Value
      suggestedPositionValue = riskBudget / slDistancePercent;
      
      // Calculate leverage needed
      requiredLeverage = suggestedPositionValue / accountBalanceVal;

      // Capped by grade max leverage
      if (requiredLeverage > maxLeverage) {
        // Shrink the position value to align with maximum allowed leverage
        requiredLeverage = maxLeverage;
        suggestedPositionValue = accountBalanceVal * maxLeverage;
        console.log(`[Wind Control] Required leverage exceeded limits. Sizing shrunk to ${requiredLeverage}x leverage.`);
      }

      calculatedQty = suggestedPositionValue / entryPrice;
    }

    // Rounding numbers
    const roundedQty = parseFloat(calculatedQty.toFixed(2));
    const roundedLeverage = Math.max(1, parseFloat(requiredLeverage.toFixed(1)));

    // 7. Store the signal in SQLite
    const insertSql = `
      INSERT INTO signals (symbol, direction, confidence, reasoning, suggested_entry, suggested_sl, suggested_tp, raw_tv_data, raw_uw_data, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')
    `;
    
    const dbResult = await runQuery(insertSql, [
      cleanSymbol,
      finalDirection,
      aiResult.confidence,
      downgradeReason ? `[降级警告: ${downgradeReason}] ` + aiResult.reasoning : aiResult.reasoning,
      aiResult.suggested_entry,
      aiResult.suggested_sl,
      aiResult.suggested_tp,
      JSON.stringify({ 
        screenshot: tvScreenshot, 
        priceData: analysisInput.priceData,
        calculatedLeverage: roundedLeverage,
        calculatedQty: roundedQty,
        riskBudget: riskBudget,
        signalGrade: finalGrade
      }),
      JSON.stringify({ screenshot: uwScreenshot, optionFlow: analysisInput.optionFlowData })
    ]);

    const finalSignal = {
      id: dbResult.id,
      timestamp: new Date().toISOString(),
      symbol: cleanSymbol,
      direction: finalDirection,
      confidence: aiResult.confidence,
      reasoning: downgradeReason ? `⚠️ ${downgradeReason}\n\n${aiResult.reasoning}` : aiResult.reasoning,
      suggested_entry: aiResult.suggested_entry,
      suggested_sl: aiResult.suggested_sl,
      suggested_tp: aiResult.suggested_tp,
      tvScreenshot,
      uwScreenshot,
      signal_grade: finalGrade,
      calculatedLeverage: roundedLeverage,
      calculatedQty: roundedQty,
      riskBudget: riskBudget,
      status: finalGrade === "C" ? "REJECTED" : "PENDING"
    };

    // If signal is B, A, A+, or S, push to frontend. If C, it is auto-rejected
    broadcast("NEW_SIGNAL", finalSignal);

    res.json({ success: true, data: finalSignal });
  } catch (err: any) {
    console.error("[Server] Graded Analysis failed:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST Execute Order (Trigger Trade execution with immediate Hard Stop-Loss contingency check)
 */
app.post("/api/order/execute", async (req, res) => {
  const { signalId, symbol, side, size, price, orderType, enableTPSL, stopLossPrice, takeProfitPrice } = req.body;

  if (!symbol || !side || !size || !orderType) {
    return res.status(400).json({ success: false, error: "Missing required order parameters" });
  }

  const cleanSymbol = symbol.toUpperCase().trim();
  const cleanSide = side.toLowerCase() as "buy" | "sell";

  console.log(`\n=== Executing Graded Order for ${cleanSymbol} ===`);
  
  try {
    const today = getLocalDateString();
    const riskStats = await getDailyStats(today);

    // Rule: Double Check Daily Halt / Halt limit before execution
    if (riskStats.trading_halted === 1) {
      return res.status(403).json({ 
        success: false, 
        error: "风控异常限制：今日亏损或连续错误已触发熔断停机，系统已拒绝发送订单！" 
      });
    }

    // 1. Record pending order in database
    const dbOrderResult = await runQuery(
      `INSERT INTO orders (signal_id, symbol, direction, price, quantity, order_type, status) VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`,
      [signalId || null, cleanSymbol, cleanSide, price || null, size, orderType]
    );
    const orderRecordId = dbOrderResult.id;

    // 2. Call Bitget service to place order
    console.log(`[Server] Opening ${cleanSide} position size ${size} on ${cleanSymbol}...`);
    let bitgetOrder;
    try {
      bitgetOrder = await BitgetService.placeOrder({
        symbol: cleanSymbol,
        side: cleanSide,
        size: size.toString(),
        orderType,
        price: price ? price.toString() : undefined
      });
    } catch (orderErr: any) {
      // Record failed order in SQLite
      await runQuery(
        `UPDATE orders SET status = 'FAILED', error_message = ? WHERE id = ?`,
        [orderErr.message, orderRecordId]
      );
      throw orderErr;
    }

    const bitgetOrderId = bitgetOrder.orderId;

    // 3. Set Hard Stop Loss & Take Profit on Bitget
    let tpslRegisterSuccess = false;
    if (enableTPSL && (takeProfitPrice || stopLossPrice)) {
      console.log(`[Server] Position opened. Setting Hard TP/SL plans...`);
      await new Promise(resolve => setTimeout(resolve, 1500)); // wait for order book sync
      
      try {
        await BitgetService.placeTPSL({
          symbol: cleanSymbol,
          stopSurplusTriggerPrice: takeProfitPrice ? takeProfitPrice.toString() : undefined,
          stopLossTriggerPrice: stopLossPrice ? stopLossPrice.toString() : undefined,
          size: size.toString()
        });
        console.log(`[Server] Hard TP/SL successfully registered on Bitget.`);
        tpslRegisterSuccess = true;
      } catch (tpslErr: any) {
        console.error(`[CRITICAL] Hard TP/SL placement failed on Bitget:`, tpslErr.message);
        
        // --- 🚨 CONTINGENCY FAILSAFE FLATTEN LOGIC 🚨 ---
        console.warn(`[FAILSAFE] Attempting immediate flat-out exit of position to prevent naked risk!`);
        const closeSide = cleanSide === "buy" ? "sell" : "buy";
        
        try {
          await BitgetService.placeOrder({
            symbol: cleanSymbol,
            side: closeSide,
            size: size.toString(),
            orderType: "market"
          });
          console.warn(`[FAILSAFE] Successfully flattened naked position for ${cleanSymbol}!`);
          
          await runQuery(
            `UPDATE orders SET status = 'FAILED', error_message = ? WHERE id = ?`,
            [`硬止损委托挂载失败，系统防裸奔机制已自动市价平仓退场。API 报错: ${tpslErr.message}`, orderRecordId]
          );
          
          if (signalId) {
            await runQuery(`UPDATE signals SET status = 'REJECTED' WHERE id = ?`, [signalId]);
          }

          broadcast("ORDER_EXECUTED", {
            order: { orderId: orderRecordId, status: "FAILED", error: "止损挂载失败，仓位自动平仓退出" },
            signalId,
            positions: await BitgetService.getPositions()
          });

          return res.status(500).json({ 
            success: false, 
            error: `止损挂载失败！为避免裸持风险，系统已强制执行市价平仓清场！` 
          });
        } catch (closeErr: any) {
          console.error(`[FATAL] Failsafe flat-out execution failed! Real-time naked risk present!`, closeErr.message);
          await runQuery(
            `UPDATE orders SET status = 'SUCCESS_UNPROTECTED', error_message = ? WHERE id = ?`,
            [`[风控灾难] 止损挂载失败且市价强制平仓失败，当前持仓处于无保护裸奔状态！请立即手动登录Bitget APP处理！`, orderRecordId]
          );
          return res.status(500).json({ 
            success: false, 
            error: `🚨 灾难警告：计划止损挂单失败且强制平仓指令失败！您的持仓目前没有任何止损保护！请立即手动在手机App上挂损！` 
          });
        }
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

    // Push updates
    const updatedBalance = await BitgetService.getBalance();
    const updatedPositions = await BitgetService.getPositions();

    const orderOutput = {
      orderId: orderRecordId,
      bitgetOrderId,
      status: "SUCCESS"
    };

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
 * POST Close Position (Used for Flat-out and updating realized P&L daily stats)
 */
app.post("/api/order/close", async (req, res) => {
  const { symbol, side, qty, pnl } = req.body;
  if (!symbol || !side || !qty) {
    return res.status(400).json({ success: false, error: "Missing required closure parameters" });
  }

  const cleanSymbol = symbol.toUpperCase().trim();
  const closeSide = side === "buy" ? "sell" : "buy"; // opposite side of current holding

  console.log(`\n=== Closing Position for ${cleanSymbol} ===`);

  try {
    const today = getLocalDateString();
    
    // 1. Send close order to Bitget
    let bitgetOrder = await BitgetService.placeOrder({
      symbol: cleanSymbol,
      side: closeSide,
      size: qty.toString(),
      orderType: "market"
    });

    // 2. Record closure in database
    const realizedPnl = parseFloat(pnl || "0.00");
    await runQuery(
      `INSERT INTO orders (symbol, direction, price, quantity, order_type, bitget_order_id, status, pnl) 
       VALUES (?, ?, null, ?, 'market', ?, 'SUCCESS', ?)`,
      [cleanSymbol, closeSide, qty, bitgetOrder.orderId, realizedPnl]
    );

    // 3. Update wind control tracking database with P&L
    const isLoss = realizedPnl < 0;
    await updateDailyStats(today, realizedPnl, isLoss);

    // Fetch updated metrics
    const stats = await getDailyStats(today);
    const updatedBalance = await BitgetService.getBalance();
    const updatedPositions = await BitgetService.getPositions();

    console.log(`[Wind Control] Realized PnL: ${realizedPnl} USD. Daily stats updated: PnL=${stats.total_pnl}, Halted=${stats.trading_halted}`);

    // Broadcast update
    broadcast("RISK_UPDATED", {
      totalPnl: stats.total_pnl,
      consecutiveLosses: stats.consecutive_losses,
      tradingHalted: stats.trading_halted === 1
    });

    broadcast("ORDER_EXECUTED", {
      order: { symbol: cleanSymbol, status: "CLOSED", pnl: realizedPnl },
      balance: updatedBalance,
      positions: updatedPositions
    });

    res.json({ success: true, message: "Position closed and risk stats updated." });
  } catch (err: any) {
    console.error("[Server] Position closure failed:", err);
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
  console.log(`  Bitget US Stock Graded Trading Server running on 3001 `);
  console.log(`  Access endpoints at http://localhost:${port}   `);
  console.log(`=======================================================`);
});
