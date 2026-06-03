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
  Image as ImageIcon,
  ShieldAlert,
  Zap
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
  signal_grade: "B" | "A" | "A+" | "S" | "C";
  calculatedLeverage?: number;
  calculatedQty?: number;
  riskBudget?: number;
  netR?: number;
  strategy?: string;
  expirationTime?: number;
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
  pnl?: number;
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

interface RiskTracker {
  today: string;
  totalPnl: number;
  consecutiveLosses: number;
  tradingHalted: boolean;
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

  // Risk Tracker State
  const [riskTracker, setRiskTracker] = useState<RiskTracker>({
    today: "",
    totalPnl: 0,
    consecutiveLosses: 0,
    tradingHalted: false
  });

  // Current selected signal
  const [activeSignal, setActiveSignal] = useState<Signal | null>(null);
  
  // Expiration countdown
  const [timeLeft, setTimeLeft] = useState<number | null>(null);

  // Order Execution settings
  const [execQty, setExecQty] = useState("10");
  const [execPrice, setExecPrice] = useState("");
  const [execType, setExecType] = useState<"market" | "limit">("market");
  const [enableTPSL, setEnableTPSL] = useState(true);
  const [tpPrice, setTpPrice] = useState("");
  const [slPrice, setSlPrice] = useState("");
  const [isExecuting, setIsExecuting] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);

  // Live countdown timer loop
  useEffect(() => {
    const timer = setInterval(() => {
      if (activeSignal && activeSignal.expirationTime) {
        const diff = activeSignal.expirationTime - Date.now();
        if (diff <= 0) {
          setTimeLeft(0);
        } else {
          setTimeLeft(Math.floor(diff / 1000));
        }
      } else {
        setTimeLeft(null);
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [activeSignal]);

  // Load initial data
  useEffect(() => {
    fetchStatus();
    fetchBalance();
    fetchPositions();
    fetchSignals();
    fetchOrders();

    const connectWS = () => {
      console.log("[WS] Connecting to server...");
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        const payload = JSON.parse(event.data);
        const { event: wsEvent, data } = payload;

        if (wsEvent === "NEW_SIGNAL") {
          // Normalizing grade params
          let calcData = { calculatedLeverage: 1, calculatedQty: 10, riskBudget: 0, signalGrade: "B", netR: 1.0, strategy: "突破回踩", expirationTime: 0 };
          try {
            const rawTv = JSON.parse(data.raw_tv_data);
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

          const parsedSignal: Signal = {
            ...data,
            signal_grade: calcData.signalGrade,
            calculatedLeverage: calcData.calculatedLeverage,
            calculatedQty: calcData.calculatedQty,
            riskBudget: calcData.riskBudget,
            netR: calcData.netR,
            strategy: calcData.strategy,
            expirationTime: calcData.expirationTime
          };

          setSignals(prev => [parsedSignal, ...prev]);
          setActiveSignal(parsedSignal);
          setExecQty(parsedSignal.calculatedQty?.toString() || "10");
          setExecPrice(parsedSignal.suggested_entry.toString());
          setTpPrice(parsedSignal.suggested_tp.toString());
          setSlPrice(parsedSignal.suggested_sl.toString());
          showNotification(`🔥 发现新的 ${parsedSignal.signal_grade} 级交易信号 (${parsedSignal.symbol})!`);
        } else if (wsEvent === "ORDER_EXECUTED") {
          fetchOrders();
          fetchPositions();
          fetchBalance();
          if (data.signalId) {
            setSignals(prev => prev.map(s => s.id === data.signalId ? { ...s, status: data.order.status === "SUCCESS" ? "EXECUTED" : "REJECTED" } : s));
            if (activeSignal && activeSignal.id === data.signalId) {
              setActiveSignal(prev => prev ? { ...prev, status: data.order.status === "SUCCESS" ? "EXECUTED" : "REJECTED" } : null);
            }
          }
          if (data.order.status === "SUCCESS") {
            showNotification("✅ 订单委托及硬止损同步挂载成功！");
          } else {
            setErrorMsg(data.order.error || "订单开仓或止损挂单被系统拦截。");
          }
        } else if (wsEvent === "SIGNAL_REJECTED") {
          setSignals(prev => prev.map(s => s.id === data.signalId ? { ...s, status: "REJECTED" } : s));
          if (activeSignal && activeSignal.id === data.signalId) {
            setActiveSignal(prev => prev ? { ...prev, status: "REJECTED" } : null);
          }
        } else if (wsEvent === "RISK_UPDATED") {
          setRiskTracker(prev => ({
            ...prev,
            totalPnl: data.totalPnl,
            consecutiveLosses: data.consecutiveLosses,
            tradingHalted: data.tradingHalted
          }));
          if (data.tradingHalted) {
            setErrorMsg("🛑 风控红色预警：今日亏损或连续错误已触发熔断保护，开仓已停机！");
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

  // Prefill fields when signal changes
  useEffect(() => {
    if (activeSignal) {
      setExecQty(activeSignal.calculatedQty?.toString() || "10");
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
      if (data.riskTracker) {
        setRiskTracker(data.riskTracker);
      }
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

  const handleResetRisk = async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/risk/reset`, { method: "POST" });
      const data = await res.json();
      if (data.success) {
        showNotification("🔄 风控熔断器重置成功，交易系统已重新启动！");
        fetchStatus();
      }
    } catch (e) {
      console.error(e);
    }
  };

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
        showNotification(`评级分析已生成: ${data.data.symbol}`);
        fetchSignals();
      }
    } catch (err: any) {
      setErrorMsg(err.message || "Failed to contact backend server");
    } finally {
      setIsAnalyzing(false);
    }
  };

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
      } else {
        fetchStatus();
      }
    } catch (err: any) {
      setErrorMsg(err.message || "Order placing failed");
    } finally {
      setIsExecuting(false);
    }
  };

  const handleClosePosition = async (pos: Position) => {
    const profitInput = prompt(`请输入平仓此仓位 ${pos.symbol} 的实际盈亏金额 (USD)，数据将同步更新日内风控：`, pos.unrealizedPL);
    if (profitInput === null) return;
    const realizedPnl = parseFloat(profitInput) || 0;
    
    try {
      const res = await fetch(`${BACKEND_URL}/api/order/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: pos.symbol,
          side: pos.side,
          qty: pos.holdQty,
          pnl: realizedPnl
        })
      });
      const r = await res.json();
      if (r.success) {
        showNotification(`✅ 仓位已平，实现损益: ${realizedPnl} USD`);
        fetchPositions();
        fetchOrders();
        fetchBalance();
        fetchStatus();
      } else {
        setErrorMsg(r.error || "平仓动作失败");
      }
    } catch (e: any) {
      setErrorMsg(e.message || "平仓发生错误");
    }
  };

  const handleRejectSignal = async () => {
    if (!activeSignal) return;
    try {
      await fetch(`${BACKEND_URL}/api/signal/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signalId: activeSignal.id })
      });
      fetchSignals();
    } catch (e) {
      console.error(e);
    }
  };

  // Helper styles based on signal grade
  const getGradeStyle = (grade: string) => {
    switch (grade) {
      case "S":
        return {
          bg: "linear-gradient(135deg, rgba(236, 72, 153, 0.2) 0%, rgba(217, 70, 239, 0.2) 100%)",
          border: "rgba(217, 70, 239, 0.5)",
          color: "#e879f9",
          glow: "0 0 18px rgba(217, 70, 239, 0.4)",
          name: "S级极强机会"
        };
      case "A+":
        return {
          bg: "linear-gradient(135deg, rgba(59, 130, 246, 0.2) 0%, rgba(16, 185, 129, 0.2) 100%)",
          border: "rgba(59, 130, 246, 0.5)",
          color: "#60a5fa",
          glow: "0 0 12px rgba(59, 130, 246, 0.3)",
          name: "A+级重点机会"
        };
      case "A":
        return {
          bg: "rgba(16, 185, 129, 0.12)",
          border: "rgba(16, 185, 129, 0.35)",
          color: "#34d399",
          glow: "none",
          name: "A级正常交易"
        };
      case "B":
        return {
          bg: "rgba(245, 158, 11, 0.1)",
          border: "rgba(245, 158, 11, 0.3)",
          color: "#fbbf24",
          glow: "none",
          name: "B级观察警报"
        };
      case "C":
      default:
        return {
          bg: "rgba(100, 116, 139, 0.1)",
          border: "rgba(100, 116, 139, 0.3)",
          color: "#94a3b8",
          glow: "none",
          name: "C级风控禁止"
        };
    }
  };

  const getSystemRiskBadge = () => {
    if (riskTracker.tradingHalted) {
      return (
        <span className="badge-short" style={{ padding: "6px 12px", borderRadius: "8px", fontWeight: "700", display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px" }}>
          <ShieldAlert size={14} /> 🛑 系统熔断停机 (HALTED)
        </span>
      );
    }
    if (riskTracker.totalPnl <= -30) {
      return (
        <span className="badge-neutral" style={{ padding: "6px 12px", borderRadius: "8px", fontWeight: "700", display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px" }}>
          ⚠️ 限重仓降级模式 (Restricted)
        </span>
      );
    }
    return (
      <span className="badge-long" style={{ padding: "6px 12px", borderRadius: "8px", fontWeight: "700", display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px" }}>
        🛡️ 系统风控就绪 (Active)
      </span>
    );
  };

  // Convert seconds to MM:SS format
  const formatTime = (secs: number | null) => {
    if (secs === null) return "";
    if (secs <= 0) return "已失效";
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
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

        <div>
          {getSystemRiskBadge()}
        </div>

        <div style={{ display: "flex", gap: "20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px" }}>
            <span style={{ width: "8px", height: "8px", borderRadius: "50%", backgroundColor: sysConfig.bitget.configured ? "#10b981" : "#f59e0b" }}></span>
            <span style={{ color: "#94a3b8" }}>Bitget API:</span>
            <span style={{ color: "white", fontWeight: "500" }}>{sysConfig.bitget.configured ? "Ready" : "Demo"}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px" }}>
            <span style={{ width: "8px", height: "8px", borderRadius: "50%", backgroundColor: sysConfig.openai.configured ? "#10b981" : "#ef4444" }}></span>
            <span style={{ color: "#94a3b8" }}>OpenAI:</span>
            <span style={{ color: "white", fontWeight: "500" }}>{sysConfig.openai.configured ? "Ready" : "Simulated"}</span>
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

      {/* Top Risk Tracker Panel */}
      <div className="glass-panel" style={{
        margin: "0 24px 16px 24px",
        padding: "16px 24px",
        display: "grid",
        gridTemplateColumns: "1fr 1fr 1fr 1fr",
        gap: "16px",
        background: "linear-gradient(180deg, rgba(17, 24, 39, 0.8) 0%, rgba(3, 7, 18, 0.9) 100%)"
      }}>
        <div>
          <span style={{ fontSize: "11px", color: "#64748b", textTransform: "uppercase" }}>今日风控日期</span>
          <p style={{ fontSize: "16px", fontWeight: "700", color: "white", marginTop: "4px" }}>{riskTracker.today || "N/A"}</p>
        </div>
        <div>
          <span style={{ fontSize: "11px", color: "#64748b", textTransform: "uppercase" }}>当日平仓盈亏</span>
          <p style={{ 
            fontSize: "20px", 
            fontWeight: "800", 
            color: riskTracker.totalPnl >= 0 ? "#10b981" : "#ef4444",
            marginTop: "4px" 
          }}>
            {riskTracker.totalPnl >= 0 ? "+" : ""}${riskTracker.totalPnl.toFixed(2)}
          </p>
        </div>
        <div>
          <span style={{ fontSize: "11px", color: "#64748b", textTransform: "uppercase" }}>日内连损计数</span>
          <p style={{ 
            fontSize: "20px", 
            fontWeight: "800", 
            color: riskTracker.consecutiveLosses >= 2 ? "#ef4444" : "white",
            marginTop: "4px" 
          }}>
            {riskTracker.consecutiveLosses} / 3 连损
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end" }}>
          <button 
            className="glass-input" 
            onClick={handleResetRisk}
            style={{ 
              fontSize: "12px", 
              cursor: "pointer", 
              padding: "6px 12px", 
              background: "rgba(255,255,255,0.05)",
              display: "flex",
              alignItems: "center",
              gap: "4px"
            }}
          >
            <RotateCcw size={12} />
            重置风控熔断
          </button>
        </div>
      </div>

      {/* Main Grid Layout */}
      <div className="grid-container">
        {/* Left Side (8 Columns) */}
        <div className="col-8" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          
          {/* Scan Center */}
          <div className="glass-panel scanline-effect" style={{ padding: "20px" }}>
            <h2 style={{ fontSize: "16px", marginBottom: "12px", display: "flex", alignItems: "center", gap: "8px" }}>
              <Cpu size={18} color="var(--accent-primary)" />
              高波动标的 AI 扫描评估 (Grader Scanner)
            </h2>
            <form onSubmit={handleAnalyze} style={{ display: "flex", gap: "12px" }}>
              <input
                type="text"
                className="glass-input"
                placeholder="输入交易代码 (如: TSLA, NVDA, SPY)..."
                value={ticker}
                onChange={(e) => setTicker(e.target.value)}
                style={{ flexGrow: 1, fontSize: "14px" }}
                disabled={isAnalyzing || riskTracker.tradingHalted}
              />
              <button 
                type="submit" 
                className="glass-button" 
                disabled={isAnalyzing || !ticker || riskTracker.tradingHalted}
                style={{ minWidth: "140px", justifyContent: "center" }}
              >
                {isAnalyzing ? "正在进行分级计算..." : "开启 AI 分级分析"}
              </button>
            </form>
          </div>

          {/* Graded Signal details */}
          {activeSignal ? (
            (() => {
              const style = getGradeStyle(activeSignal.signal_grade);
              const isExpired = timeLeft !== null && timeLeft <= 0;
              
              return (
                <div className="glass-panel" style={{ 
                  padding: "24px", 
                  display: "flex", 
                  flexDirection: "column", 
                  gap: "20px",
                  border: `1px solid ${style.border}`,
                  boxShadow: style.glow
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", borderBottom: "1px solid var(--border-color)", paddingBottom: "16px" }}>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                        <span style={{ fontSize: "28px", fontWeight: "800", letterSpacing: "-0.03em" }}>{activeSignal.symbol}</span>
                        
                        <div style={{
                          background: style.bg,
                          color: style.color,
                          border: `1px solid ${style.border}`,
                          padding: "4px 10px",
                          borderRadius: "6px",
                          fontSize: "12px",
                          fontWeight: "800",
                          letterSpacing: "0.5px"
                        }}>
                          {style.name}
                        </div>

                        <span className={`badge-${activeSignal.direction.toLowerCase()}`} style={{
                          padding: "4px 8px",
                          borderRadius: "4px",
                          fontSize: "11px",
                          fontWeight: "700"
                        }}>
                          {activeSignal.direction === "LONG" ? "买多" : activeSignal.direction === "SHORT" ? "开空" : "观望"}
                        </span>
                      </div>
                      <span style={{ fontSize: "12px", color: "#64748b", display: "block", marginTop: "4px" }}>
                        评估策略: {activeSignal.strategy} | 置信度: {(activeSignal.confidence * 100).toFixed(0)}%
                      </span>
                    </div>
                    
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "4px" }}>
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
                        {activeSignal.status === "PENDING" && "🔔 待手动确认"}
                        {activeSignal.status === "EXECUTED" && "🚀 已下单成功"}
                        {activeSignal.status === "REJECTED" && "❌ 已拒绝/超时失效"}
                      </div>
                      {activeSignal.status === "PENDING" && timeLeft !== null && (
                        <span style={{ fontSize: "11px", color: isExpired ? "#ef4444" : "#94a3b8" }}>
                          ⏱️ 信号剩余时效: <strong>{formatTime(timeLeft)}</strong>
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Analysis reasoning */}
                  <div>
                    <h3 style={{ fontSize: "14px", color: "#94a3b8", marginBottom: "8px" }}>AI 5层研判解析</h3>
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

                  {/* TradingView K-Line Screenshot */}
                  {activeSignal.tvScreenshot && (
                    <div>
                      <h3 style={{ fontSize: "14px", color: "#94a3b8", marginBottom: "8px", display: "flex", alignItems: "center", gap: "6px" }}>
                        <ImageIcon size={16} />
                        TradingView 真实股票结构图
                      </h3>
                      <div className="glass-panel" style={{
                        overflow: "hidden",
                        borderRadius: "10px",
                        maxHeight: "350px",
                        background: "#0d0e12"
                      }}>
                        <img 
                          src={`${BACKEND_URL}/screenshots/${activeSignal.tvScreenshot}`} 
                          alt="TradingView"
                          style={{ width: "100%", height: "auto", display: "block", opacity: "0.85" }}
                        />
                      </div>
                    </div>
                  )}

                  {/* Option confirm layer */}
                  {activeSignal.status === "PENDING" && activeSignal.signal_grade !== "C" && activeSignal.signal_grade !== "B" && !isExpired && (
                    <div className="glass-panel" style={{
                      padding: "20px",
                      background: "rgba(99, 102, 241, 0.03)",
                      border: "1px solid rgba(99, 102, 241, 0.15)",
                      borderRadius: "12px"
                    }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
                        <h3 style={{ fontSize: "15px", fontWeight: "700", color: "white", display: "flex", alignItems: "center", gap: "6px" }}>
                          <Zap size={16} color="var(--neutral-color)" />
                          一键量化下单确认 (Position & Risk Prefill)
                        </h3>
                        <span style={{ fontSize: "12px", color: style.color, fontWeight: "600" }}>
                          单笔风险预算上限: ${activeSignal.riskBudget} USD | 净盈亏比 (Net R): {activeSignal.netR}
                        </span>
                      </div>

                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "12px", marginBottom: "16px" }}>
                        <div style={{ display: "flex", flexDirection: "column", gap: "4px", background: "rgba(0,0,0,0.15)", padding: "10px", borderRadius: "6px" }}>
                          <span style={{ fontSize: "11px", color: "#64748b" }}>建议杠杆挡位</span>
                          <span style={{ fontSize: "16px", fontWeight: "700", color: style.color }}>
                            {activeSignal.calculatedLeverage}x
                          </span>
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: "4px", background: "rgba(0,0,0,0.15)", padding: "10px", borderRadius: "6px" }}>
                          <span style={{ fontSize: "11px", color: "#64748b" }}>仓位开仓张数</span>
                          <span style={{ fontSize: "16px", fontWeight: "700", color: "white" }}>
                            {activeSignal.calculatedQty} 张
                          </span>
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: "4px", background: "rgba(0,0,0,0.15)", padding: "10px", borderRadius: "6px" }}>
                          <span style={{ fontSize: "11px", color: "#64748b" }}>下单价格 / 止损价</span>
                          <span style={{ fontSize: "13px", fontWeight: "700", color: "#94a3b8" }}>
                            ${activeSignal.suggested_entry} / ${activeSignal.suggested_sl}
                          </span>
                        </div>
                      </div>

                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "12px", marginBottom: "16px" }}>
                        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                          <label style={{ fontSize: "11px", color: "#94a3b8" }}>委托方向</label>
                          <div className={`badge-${activeSignal.direction.toLowerCase()}`} style={{
                            padding: "8px 12px",
                            borderRadius: "8px",
                            textAlign: "center",
                            fontWeight: "700",
                            fontSize: "13px"
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
                          <label style={{ fontSize: "11px", color: "#94a3b8" }}>实际下单张数 (Size)</label>
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
                            绑定交易所硬性计划止损 (Bitget Hard SL/TP)
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
                          disabled={isExecuting || riskTracker.tradingHalted}
                          style={{
                            flexGrow: 1, 
                            justifyContent: "center",
                            background: "linear-gradient(135deg, #10b981 0%, #059669 100%)",
                            boxShadow: "0 4px 14px rgba(16, 185, 129, 0.4)"
                          }}
                        >
                          {isExecuting ? "正在发出委托中..." : "确认并一键下单 (Confirm & Exec)"}
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

                  {/* B Grade Guard Warning (Hide button) */}
                  {activeSignal.signal_grade === "B" && activeSignal.status === "PENDING" && (
                    <div className="glass-panel" style={{
                      padding: "16px",
                      background: "rgba(245, 158, 11, 0.08)",
                      border: "1px solid rgba(245, 158, 11, 0.2)",
                      color: "#fbbf24",
                      fontSize: "13px",
                      borderRadius: "8px",
                      textAlign: "center"
                    }}>
                      ⚠️ B级信号仅限观察警报。趋势/位置尚未完全确认，不支持手动确认下单。
                    </div>
                  )}

                  {/* Expired Signal Guard warning */}
                  {activeSignal.status === "PENDING" && isExpired && (
                    <div className="glass-panel" style={{
                      padding: "16px",
                      background: "rgba(239, 68, 68, 0.08)",
                      border: "1px solid rgba(239, 68, 68, 0.2)",
                      color: "#f87171",
                      fontSize: "13px",
                      borderRadius: "8px",
                      textAlign: "center"
                    }}>
                      ⏱️ 下单失败：该交易机会已超过有效窗口时间（已过期失效）。
                    </div>
                  )}

                  {/* C Grade Halt Guard warning */}
                  {activeSignal.signal_grade === "C" && (
                    <div className="glass-panel" style={{
                      padding: "16px",
                      background: "rgba(100, 116, 139, 0.08)",
                      border: "1px solid rgba(100, 116, 139, 0.2)",
                      color: "#94a3b8",
                      fontSize: "13px",
                      borderRadius: "8px",
                      textAlign: "center"
                    }}>
                      🛑 系统总闸锁定或评级为 C 级，禁止交易。
                    </div>
                  )}
                </div>
              );
            })()
          ) : (
            <div className="glass-panel" style={{ padding: "40px", textAlign: "center", color: "#64748b" }}>
              <Clock size={40} style={{ margin: "0 auto 12px auto", opacity: "0.5" }} />
              <p>暂无扫描机会。输入股票代码发起 AI Grader 扫描！</p>
            </div>
          )}
        </div>

        {/* Right Side (4 Columns) */}
        <div className="col-4" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          
          {/* Card: Account Balance */}
          <div className="glass-panel" style={{ padding: "20px" }}>
            <h2 style={{ fontSize: "15px", marginBottom: "14px", display: "flex", alignItems: "center", gap: "8px" }}>
              <DollarSign size={16} color="var(--neutral-color)" />
              资金账户状态 (Bitget Balance)
            </h2>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <span style={{ fontSize: "11px", color: "#64748b", textTransform: "uppercase" }}>账户总权益</span>
                <p style={{ fontSize: "24px", fontWeight: "800", color: "white" }}>${parseFloat(balance.usdtAmount).toLocaleString(undefined, {minimumFractionDigits: 2})}</p>
              </div>
              <div style={{ textAlign: "right" }}>
                <span style={{ fontSize: "11px", color: "#64748b", textTransform: "uppercase" }}>可用余额</span>
                <p style={{ fontSize: "18px", fontWeight: "700", color: "#10b981" }}>${parseFloat(balance.available).toLocaleString(undefined, {minimumFractionDigits: 2})}</p>
              </div>
            </div>
            {balance.mock && (
              <span style={{ display: "inline-block", marginTop: "8px", fontSize: "10px", color: "#f59e0b", background: "rgba(245, 158, 11, 0.1)", padding: "2px 6px", borderRadius: "4px" }}>
                ⚠️ 演示账户 (Mock Account)
              </span>
            )}
          </div>

          {/* Card: Active Positions with Manual Close Option */}
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
                    borderRadius: "8px"
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <span style={{ fontWeight: "700", color: "white" }}>{pos.symbol}</span>
                        <span className={pos.side === "buy" ? "badge-long" : "badge-short"} style={{
                          fontSize: "10px", padding: "1px 4px", borderRadius: "4px"
                        }}>
                          {pos.side === "buy" ? "LONG" : "SHORT"}
                        </span>
                      </div>
                      <p style={{
                        fontSize: "14px",
                        fontWeight: "700",
                        color: parseFloat(pos.unrealizedPL) >= 0 ? "#10b981" : "#ef4444"
                      }}>
                        {parseFloat(pos.unrealizedPL) >= 0 ? "+" : ""}${pos.unrealizedPL}
                      </p>
                    </div>
                    
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
                      <span style={{ fontSize: "11px", color: "#64748b" }}>
                        均价: ${pos.openPrice} | 张数: {pos.holdQty}
                      </span>
                      <button 
                        onClick={() => handleClosePosition(pos)}
                        style={{
                          background: "rgba(239, 68, 68, 0.15)",
                          border: "1px solid rgba(239, 68, 68, 0.3)",
                          color: "#ef4444",
                          padding: "3px 8px",
                          borderRadius: "4px",
                          fontSize: "11px",
                          fontWeight: "600",
                          cursor: "pointer"
                        }}
                      >
                        快速平仓
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p style={{ fontSize: "12px", color: "#64748b", textAlign: "center", padding: "12px" }}>当前没有未平仓合约</p>
            )}
          </div>

          {/* Card: History Logs */}
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
                机会评估流 (Signals)
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
                实盘下单记录 (Orders)
              </button>
            </div>

            <div style={{ flexGrow: 1, overflowY: "auto", maxHeight: "350px" }}>
              {activeTab === "dashboard" ? (
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
                          <span style={{ fontSize: "10px", color: getGradeStyle(sig.signal_grade).color, fontWeight: "800" }}>
                            {sig.signal_grade} 级
                          </span>
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span style={{ fontSize: "11px", color: "#64748b" }}>
                            方向: {sig.direction === 'LONG'?'做多':sig.direction==='SHORT'?'开空':'观望'} | {new Date(sig.timestamp).toLocaleTimeString()}
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
                  <p style={{ fontSize: "12px", color: "#64748b", textAlign: "center", padding: "20px" }}>暂无信号评估历史</p>
                )
              ) : (
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
                            color: order.status === "SUCCESS" ? "var(--long-color)" : order.status === "CLOSED" ? "var(--neutral-color)" : "var(--short-color)",
                            fontWeight: "700"
                          }}>
                            {order.status === "SUCCESS" ? "开仓成功" : order.status === "CLOSED" ? "已平仓" : "执行失败"}
                          </span>
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", color: "#64748b" }}>
                          <span>
                            {order.direction === "buy" ? "LONG" : "SHORT"} | 张数: {order.quantity}
                            {order.pnl !== undefined && order.pnl !== 0 && ` | P&L: ${order.pnl >= 0 ? '+' : ''}${order.pnl} USD`}
                          </span>
                          <span>{new Date(order.timestamp).toLocaleTimeString()}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p style={{ fontSize: "12px", color: "#64748b", textAlign: "center", padding: "20px" }}>暂无下单成交记录</p>
                )
              )}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
