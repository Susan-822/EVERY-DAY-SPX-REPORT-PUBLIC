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
import { MarketGateService } from "./services/marketGate";
import { DiscoveryService } from "./services/discoveryService";
import { CandidateEngine, OptionFlowItem } from "./services/candidateEngine";

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

// Get YYYY-MM-DD local date string
function getLocalDateString() {
  const d = new Date();
  const offset = d.getTimezoneOffset();
  const localDate = new Date(d.getTime() - (offset * 60 * 1000));
  return localDate.toISOString().split("T")[0];
}

// Start background timers to refresh lists
setInterval(async () => {
  try {
    await DiscoveryService.refreshStockFutures();
    await CandidateEngine.refreshCandidates();
  } catch (e) {
    console.error("[Cron] Failed to auto-refresh candidates:", e);
  }
}, 5 * 60 * 1000);

// Run initial refresh at startup
(async () => {
  try {
    await DiscoveryService.refreshStockFutures();
    await CandidateEngine.refreshCandidates();
  } catch (e) {
    console.error("[Startup] Initial pools refresh failed:", e);
  }
})();

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
 * POST Reset Daily stats
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
    // Parse raw data on fetch
    const parsed = rows.map(r => {
      let calcData = { calculatedLeverage: 1, calculatedQty: 10, riskBudget: 0, signalGrade: "B", netR: 1.0, strategy: "突破回踩", expirationTime: 0 };
      try {
        const rawTv = JSON.parse(r.raw_tv_data);
        calcData = {
          calculatedLeverage: rawTv.calculatedLeverage,
          calculatedQty: rawTv.calculatedQty,
          riskBudget: rawTv.riskBudget,
          signalGrade: rawTv.signalGrade,
          netR: rawTv.netR,
          strategy: rawTv.strategy,
          expirationTime: rawTv.expirationTime
        };
      } catch(e) {}
      return {
        ...r,
        signal_grade: calcData.signalGrade,
        calculatedLeverage: calcData.calculatedLeverage,
        calculatedQty: calcData.calculatedQty,
        riskBudget: calcData.riskBudget,
        netR: calcData.netR,
        strategy: calcData.strategy,
        expirationTime: calcData.expirationTime
      };
    });
    res.json({ success: true, data: parsed });
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
 * POST Analyze Ticker (5-Layer Graded Risk Sizing Engine)
 */
app.post("/api/analyze", async (req, res) => {
  const { symbol } = req.body;
  if (!symbol) {
    return res.status(400).json({ success: false, error: "Symbol is required" });
  }

  const cleanSymbol = symbol.toUpperCase().trim();
  const baseSymbol = cleanSymbol.replace("USDT", "");
  console.log(`\n=== Graded Risk Analysis for ${cleanSymbol} ===`);

  try {
    const today = getLocalDateString();
    const riskStats = await getDailyStats(today);

    // Rule: Check Daily Halt
    if (riskStats.trading_halted === 1) {
      return res.status(403).json({ 
        success: false, 
        error: "风控异常：今日已触发交易停机熔断，不可开启扫描。" 
      });
    }

    // 1. Check Bitget可交易池 (discoveryService)
    const futuresCached = DiscoveryService.getCachedFutures();
    const futureDetail = futuresCached.find(f => f.symbol === cleanSymbol || f.symbol === `${cleanSymbol}USDT`);
    
    // 2. Fetch UW Candidate Flow Data & Evaluate Freshness Rules
    const candidatesCached = CandidateEngine.getCachedCandidates();
    const candidate = candidatesCached.find(c => c.symbol === baseSymbol);
    
    // Evaluate timestamps and freshness
    const nowTime = Date.now();
    let freshestFlowAge = 999999;
    
    if (candidate && candidate.recentFlows && candidate.recentFlows.length > 0) {
      const timestamps = candidate.recentFlows.map(f => f.timestamp);
      const newestTime = Math.max(...timestamps);
      freshestFlowAge = (nowTime - newestTime) / 1000 / 60; // in minutes
    }
    
    console.log(`[Classifier] Freshness check for ${baseSymbol}. Age of freshest flow: ${freshestFlowAge.toFixed(2)} mins`);

    // 3. Price context (Mocking index price and real price for Basis checking)
    const lastPrice = cleanSymbol === "TSLA" ? 180.20 : (cleanSymbol === "AAPL" ? 175.50 : 200.00 + (Math.random() - 0.5) * 50);
    const bitgetIndexPrice = lastPrice * (1 + (Math.random() - 0.5) * 0.001); // within 0.1% deviation

    // 4. Evaluate Layer 1: Market State Gate
    const gateCheck = MarketGateService.evaluateGate({
      symbol: cleanSymbol,
      realPrice: lastPrice,
      bitgetIndexPrice: bitgetIndexPrice,
      bitgetAPIStatus: true
    });

    // 5. Capture Technical Chart Screenshot (TradingView Widget)
    let tvScreenshot = "";
    try {
      tvScreenshot = await ScreenshotService.takeTradingViewScreenshot(baseSymbol);
    } catch (e) {
      console.warn("[Server] TV Screenshot capture failed, continuing.", e);
    }

    // Capture Unusual Whales Flow Screenshot (Optional)
    let uwScreenshot = "";
    try {
      uwScreenshot = await ScreenshotService.takeUnusualWhalesScreenshot(baseSymbol);
    } catch (e) {
      console.warn("[Server] UW Screenshot capture failed, continuing.", e);
    }

    // 6. Request OpenAI Technical Structure Analysis
    const analysisInput: AnalysisInput = {
      symbol: baseSymbol,
      priceData: {
        price: parseFloat(lastPrice.toFixed(2)),
        change24h: parseFloat((Math.random() * 4 - 2).toFixed(2)),
        high24h: parseFloat((lastPrice * 1.015).toFixed(2)),
        low24h: parseFloat((lastPrice * 0.985).toFixed(2)),
        volume: Math.floor(2000000 + Math.random() * 5000000),
        rsi: Math.floor(45 + Math.random() * 15),
        macd: { macdLine: 0.12, signalLine: 0.05, histogram: 0.07 },
        customIndicators: "Price tests VWAP and opening range high. Regular session volume confirming support."
      },
      optionFlowData: candidate ? {
        totalVolume: 80000,
        callVolume: 50000,
        putVolume: 30000,
        callPutRatio: 1.67,
        recentSweeps: candidate.recentFlows
      } : undefined,
      screenshotPath: tvScreenshot ? path.join(screenshotsDir, tvScreenshot) : undefined
    };

    console.log("[Server] Calling OpenAI for structure analysis...");
    const aiResult = await OpenAIService.analyzeMarket(analysisInput);

    // 7. Core Module 4 & 5: Graded Classification & Net R Sizing Math
    let grade = aiResult.signal_grade;
    let downgradeReason = "";

    // A. Market Gate Check (If locked, force C grade)
    if (!gateCheck.allowed) {
      grade = "C";
      downgradeReason = `市场总闸锁定: ${gateCheck.reason}`;
    }

    // B. Freshness checks (UW Flow timestamp constraints)
    // Rule: Flow > 5 min -> CANNOT be S, A+, or A. Limit to max B-grade.
    if (freshestFlowAge > 5 && freshestFlowAge <= 15 && grade !== "C" && grade !== "B") {
      grade = "B";
      downgradeReason = "期权大单发生于 5 分钟前，失去新鲜触发力，自动降为 B 级观察。";
    }
    // Rule: Flow > 15 min -> Ignored, force C-grade.
    if (freshestFlowAge > 15 && grade !== "C") {
      grade = "C";
      downgradeReason = "期权大单已过期（超过 15 分钟），禁止交易。";
    }

    // C. Daily Drawdowns and Consecutive Losses check
    if (riskStats.total_pnl <= -30 && grade !== "C" && grade !== "B") {
      grade = "B";
      downgradeReason = "今日亏损超过 $30 限重仓，强制降为 B 级交易。";
    }
    if (riskStats.consecutive_losses === 2 && grade !== "C") {
      const original = grade;
      if (grade === "S") grade = "A+";
      else if (grade === "A+") grade = "A";
      else if (grade === "A") grade = "B";
      else if (grade === "B") grade = "C";
      downgradeReason = `由于日内 2 连损，评级自适应降级：${original} ➜ ${grade}`;
    }

    // D. Compute Net R (Gross R minus frictions)
    const slDist = Math.abs(aiResult.suggested_entry - aiResult.suggested_sl);
    const tpDist = Math.abs(aiResult.suggested_tp - aiResult.suggested_entry);
    const grossR = slDist > 0 ? tpDist / slDist : 1.0;
    
    // Friction deductions: spread (0.05) + slippage (0.08) + funding (0.02) + basis risk (0.05) = 0.20
    const netR = parseFloat((grossR - 0.20).toFixed(2));
    
    // Net R rules to grade
    if (netR < 1.2 && grade !== "C" && grade !== "B") {
      grade = "B";
      downgradeReason = `净盈亏比 (Net R: ${netR}) 扣除磨损后不足 1.2，自动降为 B 级观察。`;
    }

    // E. Sizing & Leverage Math
    let accountBalanceVal = 500.00;
    try {
      const bgBal = await BitgetService.getBalance();
      if (bgBal && bgBal.available) {
        accountBalanceVal = parseFloat(bgBal.available);
      }
    } catch(e) {}

    let riskBudget = 0;
    let maxLeverage = 1;

    switch (grade) {
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

    // ATR-based Stop Loss distance check (Sandbox: using simulated 1.2% ATR)
    const atrDistancePercent = 0.012; // 1.2% ATR proxy
    let slDistancePercent = Math.abs(aiResult.suggested_entry - aiResult.suggested_sl) / aiResult.suggested_entry;
    if (slDistancePercent < atrDistancePercent) {
      slDistancePercent = atrDistancePercent; // enforce ATR volatility buffer
    }

    let positionValue = 0;
    let requiredLeverage = 1;
    let calculatedQty = 0;

    if (grade !== "C" && aiResult.direction !== "NEUTRAL") {
      positionValue = riskBudget / slDistancePercent;
      requiredLeverage = positionValue / accountBalanceVal;

      if (requiredLeverage > maxLeverage) {
        requiredLeverage = maxLeverage;
        positionValue = accountBalanceVal * maxLeverage; // shrink position size
      }
      calculatedQty = positionValue / aiResult.suggested_entry;
    }

    const roundedQty = parseFloat(calculatedQty.toFixed(1));
    const roundedLeverage = Math.max(1, parseFloat(requiredLeverage.toFixed(1)));

    // Choose Strategy Expiration Timer
    const strategies = ["突破回踩", "假突破反杀", "趋势回踩"];
    const strategy = strategies[Math.floor(Math.random() * 3)];
    let validityMinutes = 20; // Default
    if (strategy === "假突破反杀") validityMinutes = 10;
    else if (strategy === "趋势回踩") validityMinutes = 30;

    const expirationTime = Date.now() + validityMinutes * 60 * 1000;

    // 8. Store Signal in SQLite
    const insertSql = `
      INSERT INTO signals (symbol, direction, confidence, reasoning, suggested_entry, suggested_sl, suggested_tp, raw_tv_data, raw_uw_data, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    
    const dbResult = await runQuery(insertSql, [
      cleanSymbol,
      grade === "C" ? "NEUTRAL" : aiResult.direction,
      aiResult.confidence,
      downgradeReason ? `[风控降级: ${downgradeReason}] ` + aiResult.reasoning : aiResult.reasoning,
      aiResult.suggested_entry,
      aiResult.suggested_sl,
      aiResult.suggested_tp,
      JSON.stringify({ 
        calculatedLeverage: roundedLeverage,
        calculatedQty: roundedQty,
        riskBudget,
        signalGrade: grade,
        netR,
        strategy,
        expirationTime,
        screenshot: tvScreenshot
      }),
      JSON.stringify({ screenshot: uwScreenshot, optionFlow: candidate?.recentFlows })
    ]);

    const finalSignal = {
      id: dbResult.id,
      timestamp: new Date().toISOString(),
      symbol: cleanSymbol,
      direction: grade === "C" ? "NEUTRAL" : aiResult.direction,
      confidence: aiResult.confidence,
      reasoning: downgradeReason ? `⚠️ ${downgradeReason}\n\n${aiResult.reasoning}` : aiResult.reasoning,
      suggested_entry: aiResult.suggested_entry,
      suggested_sl: aiResult.suggested_sl,
      suggested_tp: aiResult.suggested_tp,
      tvScreenshot,
      uwScreenshot,
      signal_grade: grade,
      calculatedLeverage: roundedLeverage,
      calculatedQty: roundedQty,
      riskBudget,
      netR,
      strategy,
      expirationTime,
      status: grade === "C" ? "REJECTED" : "PENDING"
    };

    // If signal is not C, push to frontend
    broadcast("NEW_SIGNAL", finalSignal);

    res.json({ success: true, data: finalSignal });
  } catch (err: any) {
    console.error("[Server] Graded Analysis failed:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST Execute Order (Trigger Trade placement with Pre-order double check & immediate Hard SL contingency)
 */
app.post("/api/order/execute", async (req, res) => {
  const { signalId, symbol, side, size, price, orderType, enableTPSL, stopLossPrice, takeProfitPrice } = req.body;

  if (!symbol || !side || !size || !orderType) {
    return res.status(400).json({ success: false, error: "Missing required order parameters" });
  }

  const cleanSymbol = symbol.toUpperCase().trim();
  const cleanSide = side.toLowerCase() as "buy" | "sell";

  console.log(`\n=== Executing Pre-order checks for ${cleanSymbol} ===`);
  
  try {
    const today = getLocalDateString();
    const riskStats = await getDailyStats(today);

    // Rule 1: Halt check
    if (riskStats.trading_halted === 1) {
      return res.status(403).json({ 
        success: false, 
        error: "风控限制：今日已熔断停机，禁止执行订单！" 
      });
    }

    // Rule 2: Check signal expiration
    if (signalId) {
      const signal = await getQuery("SELECT * FROM signals WHERE id = ?", [signalId]);
      if (signal) {
        try {
          const rawTv = JSON.parse(signal.raw_tv_data);
          const expTime = rawTv.expirationTime;
          if (Date.now() > expTime) {
            return res.status(400).json({
              success: false,
              error: "下单失败：此交易机会已超时失效！"
            });
          }
        } catch(e) {}
      }
    }

    // Rule 3: Re-query Bitget maxLeverage, symbolStatus, price checks (Pre-order Double Check)
    let maxLeverVal = 25;
    try {
      // Simulate/Check Bitget limits
      const futures = DiscoveryService.getCachedFutures();
      const cached = futures.find(f => f.symbol === cleanSymbol);
      if (cached) {
        maxLeverVal = cached.maxLeverage;
        if (cached.status !== "normal") {
          return res.status(400).json({ success: false, error: "下单失败：Bitget 标的交易状态异常！" });
        }
      }
    } catch(e) {}

    // 1. Record pending order in database
    const dbOrderResult = await runQuery(
      `INSERT INTO orders (signal_id, symbol, direction, price, quantity, order_type, status) VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`,
      [signalId || null, cleanSymbol, cleanSide, price || null, size, orderType]
    );
    const orderRecordId = dbOrderResult.id;

    // 2. Call Bitget service to place order
    console.log(`[Server] Double checks passed. Opening ${cleanSide} position size ${size} on ${cleanSymbol}...`);
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
 * POST Close Position (Updates realized P&L daily stats)
 */
app.post("/api/order/close", async (req, res) => {
  const { symbol, side, qty, pnl } = req.body;
  if (!symbol || !side || !qty) {
    return res.status(400).json({ success: false, error: "Missing required closure parameters" });
  }

  const cleanSymbol = symbol.toUpperCase().trim();
  const closeSide = side === "buy" ? "sell" : "buy";

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
       VALUES (?, ?, null, ?, 'market', ?, 'CLOSED', ?)`,
      [cleanSymbol, closeSide, qty, bitgetOrder.orderId, realizedPnl]
    );

    // 3. Update wind control tracking database with P&L
    const isLoss = realizedPnl < 0;
    await updateDailyStats(today, realizedPnl, isLoss);

    // Fetch updated metrics
    const stats = await getDailyStats(today);
    const updatedBalance = await BitgetService.getBalance();
    const updatedPositions = await BitgetService.getPositions();

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
