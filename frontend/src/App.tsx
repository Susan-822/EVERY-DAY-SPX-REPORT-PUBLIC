import React, { useState, useEffect, useRef } from "react";
import { 
  X, 
  Check, 
  AlertCircle, 
  Cpu, 
  Activity, 
  Layers, 
  DollarSign, 
  Clock, 
  RotateCcw, 
  Image as ImageIcon 
} from "lucide-react";

interface Signal {
  id: number;
  timestamp: string;
  symbol: string;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  confidence: number;
  reasoning: string;
  suggested_entry: number;
  suggested_sl: number;
  suggested_tp: number;
  tvScreenshot?: string;
  uwScreenshot?: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "EXECUTED";
}

interface Order {
  id: number;
  timestamp: string;
  symbol: string;
  direction: "buy" | "sell";
  price: number | null;
  quantity: number;
  order_type: string;
  bitget_order_id: string;
  status: string;
}

interface Position {
  symbol: string;
  side: "buy" | "sell";
  holdQty: string;
  openPrice: string;
  marketPrice: string;
  unrealizedPL: string;
  mock?: boolean;
}

const BACKEND_URL = "http://localhost:3001";
const WS_URL = "ws://localhost:3001";

export default function App() {
  // States
  const [activeTab, setActiveTab] = useState<"dashboard" | "history">("dashboard");
  const [ticker, setTicker] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [successMsg, setSuccessMsg] = useState("");
  
  // Dashboard Metrics
  const [balance, setBalance] = useState({ usdtAmount: "0.00", available: "0.00", mock: false });
  const [positions, setPositions] = useState<Position[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [sysConfig, setSysConfig] = useState({
    bitget: { configured: false, apiUrl: "" },
    openai: { configured: false },
    unusualWhales: { configured: false }
  });

  // Current selected signal for manual action
  const [activeSignal, setActiveSignal] = useState<Signal | null>(null);
  
  // Order Execution settings
  const [execQty, setExecQty] = useState("10");
  const [execPrice, setExecPrice] = useState("");
  const [execType, setExecType] = useState<"market" | "limit">("market");
  const [enableTPSL, setEnableTPSL] = useState(true);
  const [tpPrice, setTpPrice] = useState("");
  const [slPrice, setSlPrice] = useState("");
  const [isExecuting, setIsExecuting] = useState(false);

  // WebSockets ref
  const wsRef = useRef<WebSocket | null>(null);

  // Load initial data
  useEffect(() => {
    fetchStatus();
    fetchBalance();
    fetchPositions();
    fetchSignals();
    fetchOrders();

    // WebSocket logic
    const connectWS = () => {
      console.log("[WS] Connecting to server...");
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        const payload = JSON.parse(event.data);
        const { event: wsEvent, data } = payload;
        console.log(`[WS] Event: ${wsEvent}`, data);

        if (wsEvent === "NEW_SIGNAL") {
          setSignals(prev => [data, ...prev]);
          setActiveSignal(data);
          // Set prefilled details
          setExecPrice(data.suggested_entry.toString());
          setTpPrice(data.suggested_tp.toString());
          setSlPrice(data.suggested_sl.toString());
          showNotification("🔥 New AI Trade Signal Received!");
        } else if (wsEvent === "ORDER_EXECUTED") {
          fetchOrders();
          fetchPositions();
          fetchBalance();
          if (data.signalId) {
            setSignals(prev => prev.map(s => s.id === data.signalId ? { ...s, status: "EXECUTED" } : s));
            if (activeSignal && activeSignal.id === data.signalId) {
              setActiveSignal(prev => prev ? { ...prev, status: "EXECUTED" } : null);
            }
          }
          showNotification("✅ Order Placed Successfully on Bitget!");
        } else if (wsEvent === "SIGNAL_REJECTED") {
          setSignals(prev => prev.map(s => s.id === data.signalId ? { ...s, status: "REJECTED" } : s));
          if (activeSignal && activeSignal.id === data.signalId) {
            setActiveSignal(prev => prev ? { ...prev, status: "REJECTED" } : null);
          }
        }
      };

      ws.onclose = () => {
        console.log("[WS] Connection lost. Reconnecting in 5s...");
        setTimeout(connectWS, 5000);
      };
    };

    connectWS();

    return () => {
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  // Set default values whenever active signal changes
  useEffect(() => {
    if (activeSignal) {
      setExecPrice(activeSignal.suggested_entry.toString());
      setTpPrice(activeSignal.suggested_tp.toString());
      setSlPrice(activeSignal.suggested_sl.toString());
    }
  }, [activeSignal]);

  const showNotification = (msg: string) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(""), 5000);
  };

  // API calls
  const fetchStatus = async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/status`);
      const data = await res.json();
      setSysConfig(data);
    } catch (e) {
      console.error(e);
    }
  };

  const fetchBalance = async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/balance`);
      const r = await res.json();
      if (r.success) {
        if (Array.isArray(r.data)) {
          // If Bitget returns array
          const usdtAcc = r.data.find((a: any) => a.marginCoin === "USDT");
          setBalance({
            usdtAmount: usdtAcc?.equity || "0.00",
            available: usdtAcc?.available || "0.00",
            mock: false
          });
        } else {
          setBalance({
            usdtAmount: r.data.usdtAmount || "0.00",
            available: r.data.available || "0.00",
            mock: !!r.data.mock
          });
        }
      }
    } catch (e) {
      console.error(e);
    }
  };

  const fetchPositions = async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/positions`);
      const r = await res.json();
      if (r.success) {
        setPositions(r.data || []);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const fetchSignals = async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/signals`);
      const r = await res.json();
      if (r.success) {
        setSignals(r.data || []);
        // Pick first pending or first signal
        const pending = (r.data || []).find((s: Signal) => s.status === "PENDING");
        if (pending) {
          setActiveSignal(pending);
        } else if (r.data?.length > 0) {
          setActiveSignal(r.data[0]);
        }
      }
    } catch (e) {
      console.error(e);
    }
  };

  const fetchOrders = async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/orders`);
      const r = await res.json();
      if (r.success) {
        setOrders(r.data || []);
      }
    } catch (e) {
      console.error(e);
    }
  };

  // Trigger analysis
  const handleAnalyze = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ticker) return;
    setIsAnalyzing(true);
    setErrorMsg("");
    try {
      const res = await fetch(`${BACKEND_URL}/api/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: ticker })
      });
      const data = await res.json();
      if (!data.success) {
        setErrorMsg(data.error || "Analysis failed");
      } else {
        setTicker("");
        showNotification(`Successfully completed analysis for ${data.data.symbol}!`);
      }
    } catch (err: any) {
      setErrorMsg(err.message || "Failed to contact backend server");
    } finally {
      setIsAnalyzing(false);
    }
  };

  // Approve and execute manual order
  const handleExecuteOrder = async () => {
    if (!activeSignal) return;
    setIsExecuting(true);
    setErrorMsg("");
    try {
      const res = await fetch(`${BACKEND_URL}/api/order/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          signalId: activeSignal.id,
          symbol: activeSignal.symbol + "USDT",
          side: activeSignal.direction === "LONG" ? "buy" : "sell",
          size: execQty,
          price: execType === "limit" ? execPrice : undefined,
          orderType: execType,
          enableTPSL,
          takeProfitPrice: enableTPSL ? tpPrice : undefined,
          stopLossPrice: enableTPSL ? slPrice : undefined
        })
      });
      const data = await res.json();
      if (!data.success) {
        setErrorMsg(data.error || "Order execution failed");
      }
    } catch (err: any) {
      setErrorMsg(err.message || "Order placing failed");
    } finally {
      setIsExecuting(false);
    }
  };

  // Reject trade suggestion
  const handleRejectSignal = async () => {
    if (!activeSignal) return;
    try {
      await fetch(`${BACKEND_URL}/api/signal/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signalId: activeSignal.id })
      });
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div style={{ paddingBottom: "60px" }}>
      {/* Header Bar */}
      <header className="glass-panel" style={{
        margin: "16px 24px",
        padding: "16px 24px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        borderBottom: "1px solid var(--border-color)",
        background: "rgba(10, 15, 30, 0.7)"
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div style={{
            background: "linear-gradient(135deg, #4f46e5 0%, #6366f1 100%)",
            width: "40px",
            height: "40px",
            borderRadius: "10px",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            boxShadow: "0 0 15px rgba(99, 102, 241, 0.4)"
          }}>
            <Activity size={22} color="white" />
          </div>
          <div>
            <h1 style={{ fontSize: "20px", fontWeight: "700" }}>ANTIGRAVITY WHALE</h1>
            <span style={{ fontSize: "11px", color: "#64748b", textTransform: "uppercase", letterSpacing: "1px" }}>
              Bitget Stock Derivatives Terminal
            </span>
          </div>
        </div>

        {/* System Indicators */}
        <div style={{ display: "flex", gap: "20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px" }}>
            <span style={{ width: "8px", height: "8px", borderRadius: "50%", backgroundColor: sysConfig.bitget.configured ? "#10b981" : "#f59e0b" }}></span>
            <span style={{ color: "#94a3b8" }}>Bitget API:</span>
            <span style={{ color: "white", fontWeight: "500" }}>{sysConfig.bitget.configured ? "Ready" : "Demo Mode"}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px" }}>
            <span style={{ width: "8px", height: "8px", borderRadius: "50%", backgroundColor: sysConfig.openai.configured ? "#10b981" : "#ef4444" }}></span>
            <span style={{ color: "#94a3b8" }}>OpenAI:</span>
            <span style={{ color: "white", fontWeight: "500" }}>{sysConfig.openai.configured ? "Ready" : "Simulated"}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px" }}>
            <span style={{ width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#10b981" }}></span>
            <span style={{ color: "#94a3b8" }}>DB:</span>
            <span style={{ color: "white", fontWeight: "500" }}>Connected</span>
          </div>
        </div>
      </header>

      {/* Messages */}
      {successMsg && (
        <div className="glass-panel" style={{
          margin: "0 24px 16px 24px",
          padding: "12px 20px",
          backgroundColor: "rgba(16, 185, 129, 0.15)",
          border: "1px solid rgba(16, 185, 129, 0.4)",
          color: "#34d399",
          borderRadius: "8px",
          display: "flex",
          alignItems: "center",
          gap: "10px"
        }}>
          <Check size={18} />
          <span>{successMsg}</span>
        </div>
      )}
      {errorMsg && (
        <div className="glass-panel" style={{
          margin: "0 24px 16px 24px",
          padding: "12px 20px",
          backgroundColor: "rgba(239, 68, 68, 0.15)",
          border: "1px solid rgba(239, 68, 68, 0.4)",
          color: "#f87171",
          borderRadius: "8px",
          display: "flex",
          alignItems: "center",
          gap: "10px"
        }}>
          <AlertCircle size={18} />
          <span>{errorMsg}</span>
        </div>
      )}

      {/* Main Grid Layout */}
      <div className="grid-container">
        {/* Left Side: Controls, AI recommendation, chart & execution (8 Columns) */}
        <div className="col-8" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          
          {/* Section: Trigger Ticker Scan */}
          <div className="glass-panel scanline-effect" style={{ padding: "20px" }}>
            <h2 style={{ fontSize: "16px", marginBottom: "12px", display: "flex", alignItems: "center", gap: "8px" }}>
              <Cpu size={18} color="var(--accent-primary)" />
              扫描分析中心 (AI Scanner Center)
            </h2>
            <form onSubmit={handleAnalyze} style={{ display: "flex", gap: "12px" }}>
              <input
                type="text"
                className="glass-input"
                placeholder="输入股票代码 (如: TSLA, AAPL, NVDA)..."
                value={ticker}
                onChange={(e) => setTicker(e.target.value)}
                style={{ flexGrow: 1, fontSize: "14px" }}
                disabled={isAnalyzing}
              />
              <button 
                type="submit" 
                className="glass-button" 
                disabled={isAnalyzing || !ticker}
                style={{ minWidth: "140px", justifyContent: "center" }}
              >
                {isAnalyzing ? "正在进行深度分析..." : "开启 AI 扫描"}
              </button>
            </form>
          </div>

          {/* Section: Selected Signal Details & Confirmation */}
          {activeSignal ? (
            <div className="glass-panel" style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "20px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", borderBottom: "1px solid var(--border-color)", paddingBottom: "16px" }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                    <span style={{ fontSize: "28px", fontWeight: "800", letterSpacing: "-0.03em" }}>{activeSignal.symbol}</span>
                    <span className={`badge-${activeSignal.direction.toLowerCase()}`} style={{
                      padding: "4px 10px",
                      borderRadius: "6px",
                      fontSize: "12px",
                      fontWeight: "700",
                      letterSpacing: "0.5px"
                    }}>
                      {activeSignal.direction}
                    </span>
                    <span style={{ color: "#64748b", fontSize: "13px" }}>
                      Confidence: {(activeSignal.confidence * 100).toFixed(0)}%
                    </span>
                  </div>
                  <span style={{ fontSize: "12px", color: "#64748b", display: "block", marginTop: "4px" }}>
                    信号生成时间: {new Date(activeSignal.timestamp).toLocaleString()}
                  </span>
                </div>
                
                {/* Status indicator badge */}
                <div style={{
                  padding: "6px 12px",
                  borderRadius: "8px",
                  fontSize: "12px",
                  fontWeight: "600",
                  backgroundColor: 
                    activeSignal.status === "EXECUTED" ? "rgba(16, 185, 129, 0.1)" :
                    activeSignal.status === "REJECTED" ? "rgba(239, 68, 68, 0.1)" : "rgba(99, 102, 241, 0.1)",
                  color: 
                    activeSignal.status === "EXECUTED" ? "var(--long-color)" :
                    activeSignal.status === "REJECTED" ? "var(--short-color)" : "var(--accent-primary)",
                  border: `1px solid ${
                    activeSignal.status === "EXECUTED" ? "rgba(16, 185, 129, 0.2)" :
                    activeSignal.status === "REJECTED" ? "rgba(239, 68, 68, 0.2)" : "rgba(99, 102, 241, 0.2)"
                  }`
                }}>
                  {activeSignal.status === "PENDING" && "🔔 待确认交易"}
                  {activeSignal.status === "EXECUTED" && "🚀 已下单执行"}
                  {activeSignal.status === "REJECTED" && "❌ 已拒绝忽略"}
                </div>
              </div>

              {/* Reasoning Block */}
              <div>
                <h3 style={{ fontSize: "14px", color: "#94a3b8", marginBottom: "8px" }}>AI 综合策略理由</h3>
                <div style={{
                  background: "rgba(0, 0, 0, 0.25)",
                  padding: "16px",
                  borderRadius: "8px",
                  border: "1px solid var(--border-color)",
                  lineHeight: "1.6",
                  fontSize: "14px",
                  color: "#cbd5e1"
                }}>
                  {activeSignal.reasoning}
                </div>
              </div>

              {/* Multimodal Screenshot Block */}
              {activeSignal.tvScreenshot && (
                <div>
                  <h3 style={{ fontSize: "14px", color: "#94a3b8", marginBottom: "8px", display: "flex", alignItems: "center", gap: "6px" }}>
                    <ImageIcon size={16} />
                    TradingView K线及指标视觉截图
                  </h3>
                  <div className="glass-panel" style={{
                    overflow: "hidden",
                    borderRadius: "10px",
                    maxHeight: "350px",
                    background: "#0d0e12"
                  }}>
                    <img 
                      src={`${BACKEND_URL}/screenshots/${activeSignal.tvScreenshot}`} 
                      alt="TradingView Chart"
                      style={{ width: "100%", height: "auto", display: "block", opacity: "0.85" }}
                    />
                  </div>
                </div>
              )}

              {/* Order Execution Settings Panel */}
              {activeSignal.status === "PENDING" && (
                <div className="glass-panel" style={{
                  padding: "20px",
                  background: "rgba(99, 102, 241, 0.04)",
                  border: "1px solid rgba(99, 102, 241, 0.15)",
                  borderRadius: "12px"
                }}>
                  <h3 style={{ fontSize: "15px", fontWeight: "600", marginBottom: "14px", color: "white" }}>
                    ⚡ 确认并下单至 Bitget USDT-FUTURES
                  </h3>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "12px", marginBottom: "16px" }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                      <label style={{ fontSize: "11px", color: "#94a3b8" }}>委托方向</label>
                      <div className={`badge-${activeSignal.direction.toLowerCase()}`} style={{
                        padding: "8px 12px",
                        borderRadius: "8px",
                        textAlign: "center",
                        fontWeight: "700",
                        fontSize: "14px"
                      }}>
                        {activeSignal.direction === "LONG" ? "买入开多 (LONG)" : "卖出开空 (SHORT)"}
                      </div>
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                      <label style={{ fontSize: "11px", color: "#94a3b8" }}>委托类型</label>
                      <select 
                        className="glass-input" 
                        value={execType} 
                        onChange={(e) => setExecType(e.target.value as any)}
                        style={{ background: "#0b0c16", padding: "8px 12px", height: "38px" }}
                      >
                        <option value="market">市价委托 (Market)</option>
                        <option value="limit">限价委托 (Limit)</option>
                      </select>
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                      <label style={{ fontSize: "11px", color: "#94a3b8" }}>数量 (合约张数/Size)</label>
                      <input 
                        type="number" 
                        className="glass-input"
                        value={execQty}
                        onChange={(e) => setExecQty(e.target.value)}
                        style={{ height: "38px" }}
                      />
                    </div>
                  </div>

                  {execType === "limit" && (
                    <div style={{ display: "flex", flexDirection: "column", gap: "4px", marginBottom: "16px" }}>
                      <label style={{ fontSize: "11px", color: "#94a3b8" }}>限价委托价格 (USD)</label>
                      <input 
                        type="number" 
                        className="glass-input"
                        value={execPrice}
                        onChange={(e) => setExecPrice(e.target.value)}
                        step="0.01"
                      />
                    </div>
                  )}

                  {/* TP / SL Config */}
                  <div style={{ marginBottom: "20px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }}>
                      <input 
                        type="checkbox" 
                        id="tpsl" 
                        checked={enableTPSL}
                        onChange={(e) => setEnableTPSL(e.target.checked)}
                        style={{ accentColor: "var(--accent-primary)", width: "16px", height: "16px" }}
                      />
                      <label htmlFor="tpsl" style={{ fontSize: "13px", fontWeight: "600", color: "white" }}>
                        开启止盈止损计划 (Enable TP/SL Plan)
                      </label>
                    </div>

                    {enableTPSL && (
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                          <label style={{ fontSize: "11px", color: "#34d399" }}>止盈价格 (Take Profit)</label>
                          <input 
                            type="number" 
                            className="glass-input"
                            value={tpPrice}
                            onChange={(e) => setTpPrice(e.target.value)}
                            step="0.01"
                            style={{ border: "1px solid rgba(16, 185, 129, 0.2)" }}
                          />
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                          <label style={{ fontSize: "11px", color: "#f87171" }}>止损价格 (Stop Loss)</label>
                          <input 
                            type="number" 
                            className="glass-input"
                            value={slPrice}
                            onChange={(e) => setSlPrice(e.target.value)}
                            step="0.01"
                            style={{ border: "1px solid rgba(239, 68, 68, 0.2)" }}
                          />
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Actions buttons */}
                  <div style={{ display: "flex", gap: "12px" }}>
                    <button 
                      className="glass-button" 
                      onClick={handleExecuteOrder} 
                      disabled={isExecuting}
                      style={{
                        flexGrow: 1, 
                        justifyContent: "center",
                        background: "linear-gradient(135deg, #10b981 0%, #059669 100%)",
                        boxShadow: "0 4px 14px rgba(16, 185, 129, 0.4)"
                      }}
                    >
                      {isExecuting ? "正在下单中..." : "确认并一键下单 (Approve & Exec)"}
                    </button>
                    
                    <button 
                      onClick={handleRejectSignal} 
                      className="glass-input" 
                      style={{
                        padding: "10px 20px", 
                        cursor: "pointer", 
                        background: "rgba(255,255,255,0.05)",
                        fontWeight: "600",
                        display: "flex",
                        alignItems: "center",
                        gap: "6px"
                      }}
                    >
                      <X size={16} />
                      拒绝信号
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="glass-panel" style={{ padding: "40px", textAlign: "center", color: "#64748b" }}>
              <Clock size={40} style={{ margin: "0 auto 12px auto", opacity: "0.5" }} />
              <p>暂无交易信号。请输入股票代码并启动 AI 扫描分析！</p>
            </div>
          )}
        </div>

        {/* Right Side: Account Balance, Position Lists & History Logs (4 Columns) */}
        <div className="col-4" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          
          {/* Card: Account Balance */}
          <div className="glass-panel" style={{ padding: "20px" }}>
            <h2 style={{ fontSize: "15px", marginBottom: "14px", display: "flex", alignItems: "center", gap: "8px" }}>
              <DollarSign size={16} color="var(--neutral-color)" />
              资金账户状态 (Account Balance)
            </h2>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <span style={{ fontSize: "11px", color: "#64748b", textTransform: "uppercase" }}>账户权益 (USDT)</span>
                <p style={{ fontSize: "24px", fontWeight: "800", color: "white" }}>${parseFloat(balance.usdtAmount).toLocaleString(undefined, {minimumFractionDigits: 2})}</p>
              </div>
              <div style={{ textAlign: "right" }}>
                <span style={{ fontSize: "11px", color: "#64748b", textTransform: "uppercase" }}>可用余额 (USDT)</span>
                <p style={{ fontSize: "18px", fontWeight: "700", color: "#10b981" }}>${parseFloat(balance.available).toLocaleString(undefined, {minimumFractionDigits: 2})}</p>
              </div>
            </div>
            {balance.mock && (
              <span style={{ display: "inline-block", marginTop: "8px", fontSize: "10px", color: "#f59e0b", background: "rgba(245, 158, 11, 0.1)", padding: "2px 6px", borderRadius: "4px" }}>
                ⚠️ 演示账户 (Mock Account)
              </span>
            )}
          </div>

          {/* Card: Active Positions */}
          <div className="glass-panel" style={{ padding: "20px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
              <h2 style={{ fontSize: "15px", display: "flex", alignItems: "center", gap: "8px" }}>
                <Layers size={16} color="var(--accent-primary)" />
                当前持仓 (Open Positions)
              </h2>
              <button onClick={fetchPositions} style={{ background: "none", border: "none", cursor: "pointer", color: "#64748b" }}>
                <RotateCcw size={14} />
              </button>
            </div>

            {positions.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                {positions.map((pos, idx) => (
                  <div key={idx} style={{
                    background: "rgba(0,0,0,0.2)",
                    border: "1px solid var(--border-color)",
                    padding: "12px",
                    borderRadius: "8px",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center"
                  }}>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <span style={{ fontWeight: "700", color: "white" }}>{pos.symbol}</span>
                        <span className={pos.side === "buy" ? "badge-long" : "badge-short"} style={{
                          fontSize: "10px", padding: "2px 4px", borderRadius: "4px"
                        }}>
                          {pos.side === "buy" ? "LONG" : "SHORT"}
                        </span>
                      </div>
                      <span style={{ fontSize: "11px", color: "#64748b" }}>
                        开仓价: ${pos.openPrice} | 数量: {pos.holdQty}
                      </span>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <p style={{
                        fontSize: "14px",
                        fontWeight: "700",
                        color: parseFloat(pos.unrealizedPL) >= 0 ? "#10b981" : "#ef4444"
                      }}>
                        {parseFloat(pos.unrealizedPL) >= 0 ? "+" : ""}${pos.unrealizedPL}
                      </p>
                      <span style={{ fontSize: "11px", color: "#64748b" }}>标记价: ${pos.marketPrice}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p style={{ fontSize: "12px", color: "#64748b", textAlign: "center", padding: "12px" }}>无活跃仓位</p>
            )}
          </div>

          {/* Card: Signals / Logs History Feed */}
          <div className="glass-panel" style={{ padding: "20px", flexGrow: 1, display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", gap: "12px", borderBottom: "1px solid var(--border-color)", marginBottom: "12px", paddingBottom: "4px" }}>
              <button 
                onClick={() => setActiveTab("dashboard")}
                style={{
                  background: "none",
                  border: "none",
                  color: activeTab === "dashboard" ? "white" : "#64748b",
                  fontWeight: "600",
                  fontSize: "13px",
                  cursor: "pointer",
                  paddingBottom: "8px",
                  borderBottom: activeTab === "dashboard" ? "2px solid var(--accent-primary)" : "none"
                }}
              >
                信号流历史 (Signals)
              </button>
              <button 
                onClick={() => setActiveTab("history")}
                style={{
                  background: "none",
                  border: "none",
                  color: activeTab === "history" ? "white" : "#64748b",
                  fontWeight: "600",
                  fontSize: "13px",
                  cursor: "pointer",
                  paddingBottom: "8px",
                  borderBottom: activeTab === "history" ? "2px solid var(--accent-primary)" : "none"
                }}
              >
                下单记录 (Orders)
              </button>
            </div>

            <div style={{ flexGrow: 1, overflowY: "auto", maxHeight: "350px" }}>
              {activeTab === "dashboard" ? (
                // Signals Feed list
                signals.length > 0 ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    {signals.map((sig) => (
                      <div 
                        key={sig.id} 
                        onClick={() => setActiveSignal(sig)}
                        style={{
                          padding: "10px 12px",
                          borderRadius: "8px",
                          border: activeSignal?.id === sig.id ? "1px solid var(--accent-primary)" : "1px solid var(--border-color)",
                          background: activeSignal?.id === sig.id ? "rgba(99, 102, 241, 0.06)" : "rgba(0, 0, 0, 0.15)",
                          cursor: "pointer",
                          transition: "all 0.2s ease"
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                          <span style={{ fontWeight: "700", color: "white" }}>{sig.symbol}</span>
                          <span className={`badge-${sig.direction.toLowerCase()}`} style={{ fontSize: "10px", padding: "1px 4px", borderRadius: "4px" }}>
                            {sig.direction}
                          </span>
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span style={{ fontSize: "11px", color: "#64748b" }}>
                            {new Date(sig.timestamp).toLocaleTimeString()}
                          </span>
                          <span style={{
                            fontSize: "11px",
                            color: 
                              sig.status === "EXECUTED" ? "var(--long-color)" :
                              sig.status === "REJECTED" ? "var(--short-color)" : "#94a3b8"
                          }}>
                            {sig.status}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p style={{ fontSize: "12px", color: "#64748b", textAlign: "center", padding: "20px" }}>暂无分析历史</p>
                )
              ) : (
                // Orders History log
                orders.length > 0 ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    {orders.map((order) => (
                      <div key={order.id} style={{
                        padding: "10px 12px",
                        borderRadius: "8px",
                        border: "1px solid var(--border-color)",
                        background: "rgba(0, 0, 0, 0.15)",
                        fontSize: "12px"
                      }}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                          <span style={{ fontWeight: "700", color: "white" }}>{order.symbol}</span>
                          <span style={{
                            color: order.status === "SUCCESS" ? "var(--long-color)" : "var(--short-color)"
                          }}>
                            {order.status}
                          </span>
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", color: "#64748b" }}>
                          <span>
                            {order.direction === "buy" ? "LONG" : "SHORT"} | Qty: {order.quantity}
                          </span>
                          <span>{new Date(order.timestamp).toLocaleTimeString()}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p style={{ fontSize: "12px", color: "#64748b", textAlign: "center", padding: "20px" }}>暂无下单记录</p>
                )
              )}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
