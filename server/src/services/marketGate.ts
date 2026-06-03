import dotenv from "dotenv";

dotenv.config();

// High impact event times (mock calendar data in UTC format)
const HIGH_IMPACT_EVENTS = [
  "2026-06-03T18:00:00.000Z", // FOMC meeting example
  "2026-06-12T12:30:00.000Z", // CPI release example
  "2026-06-05T12:30:00.000Z", // Non-Farm Payrolls example
];

export class MarketGateService {
  /**
   * Checks if current time is near any high-impact economic news events (within 30 minutes before/after)
   */
  static isNearMajorEvent(): { isNear: boolean; event: string } {
    const now = Date.now();
    const windowMs = 30 * 60 * 1000; // 30 minutes

    for (const eventStr of HIGH_IMPACT_EVENTS) {
      const eventTime = new Date(eventStr).getTime();
      if (Math.abs(now - eventTime) < windowMs) {
        return { isNear: true, event: new Date(eventTime).toUTCString() };
      }
    }
    return { isNear: false, event: "" };
  }

  /**
   * Verify if current time falls in the US Regular Trading Hours (9:30 AM - 4:00 PM EST, Monday to Friday)
   */
  static isRegularTradingHours(): { isRegular: boolean; reason: string } {
    const now = new Date();
    
    // Convert current UTC time to EST (New York) timezone
    const nyTimeStr = now.toLocaleString("en-US", { timeZone: "America/New_York" });
    const nyDate = new Date(nyTimeStr);
    
    const day = nyDate.getDay(); // 0 = Sunday, 6 = Saturday
    const hours = nyDate.getHours();
    const minutes = nyDate.getMinutes();
    
    if (day === 0 || day === 6) {
      return { isRegular: false, reason: "周末休市 (Weekend - Market Closed)" };
    }

    const timeInMinutes = hours * 60 + minutes;
    const startInMinutes = 9 * 60 + 30; // 9:30 AM
    const endInMinutes = 16 * 60;       // 4:00 PM

    if (timeInMinutes < startInMinutes || timeInMinutes > endInMinutes) {
      return { isRegular: false, reason: "盘前或盘后时段，流动性薄弱 (Premarket / Postmarket - Thin Liquidity)" };
    }

    return { isRegular: true, reason: "" };
  }

  /**
   * Verify price deviation (basis checker) between real stock price and Bitget contract index price
   */
  static checkPriceDeviation(realPrice: number, bitgetIndexPrice: number): { isDeviated: boolean; deviationPercent: number } {
    if (realPrice <= 0 || bitgetIndexPrice <= 0) {
      return { isDeviated: true, deviationPercent: 1.0 }; // Abnormal prices
    }
    
    const deviation = Math.abs(realPrice - bitgetIndexPrice) / realPrice;
    const isDeviated = deviation > 0.005; // 0.5% max allowed deviation

    return { isDeviated, deviationPercent: parseFloat((deviation * 100).toFixed(2)) };
  }

  /**
   * Combined status lock check
   */
  static evaluateGate(params: {
    symbol: string;
    realPrice: number;
    bitgetIndexPrice: number;
    bitgetAPIStatus: boolean;
  }): { allowed: boolean; reason: string } {
    // 1. Check Bitget API Connectivity
    if (!params.bitgetAPIStatus) {
      return { allowed: false, reason: "Bitget 合约维护或 API 交易不可用" };
    }

    // 2. Check major economic events calendar
    const eventCheck = this.isNearMajorEvent();
    if (eventCheck.isNear) {
      return { allowed: false, reason: `重大宏观事件锁定: 靠近重要讲话/数据公布时间 (${eventCheck.event})` };
    }

    // 3. Check regular trading hours
    const hoursCheck = this.isRegularTradingHours();
    if (!hoursCheck.isRegular) {
      return { allowed: false, reason: hoursCheck.reason };
    }

    // 4. Check price deviation between real stock & synthetic future
    const devCheck = this.checkPriceDeviation(params.realPrice, params.bitgetIndexPrice);
    if (devCheck.isDeviated) {
      return { allowed: false, reason: `价格严重偏离: 真实股票价与Bitget合约指数价偏差过大 (${devCheck.deviationPercent}%)` };
    }

    return { allowed: true, reason: "ACTIVE" };
  }
}
