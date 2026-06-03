import axios from "axios";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

const API_KEY = process.env.BITGET_API_KEY || "";
const API_SECRET = process.env.BITGET_API_SECRET || "";
const PASSPHRASE = process.env.BITGET_PASSPHRASE || "";
const BASE_URL = process.env.BITGET_API_URL || "https://api.bitget.com";

// Check if credentials are set
const isConfigured = !!(API_KEY && API_SECRET && PASSPHRASE);

function generateSign(timestamp: number, method: string, requestPath: string, body: string = ""): string {
  const preHash = timestamp + method.toUpperCase() + requestPath + body;
  return crypto.createHmac("sha256", API_SECRET).update(preHash).digest("base64");
}

function getHeaders(method: string, requestPath: string, bodyObj: any = null): any {
  const timestamp = Date.now();
  const bodyStr = bodyObj ? JSON.stringify(bodyObj) : "";
  const sign = generateSign(timestamp, method, requestPath, bodyStr);

  return {
    "ACCESS-KEY": API_KEY,
    "ACCESS-SIGN": sign,
    "ACCESS-TIMESTAMP": timestamp.toString(),
    "ACCESS-PASSPHRASE": PASSPHRASE,
    "Content-Type": "application/json",
  };
}

export class BitgetService {
  /**
   * Check if Bitget credentials are configured
   */
  static isConfigured(): boolean {
    return isConfigured;
  }

  /**
   * Get Account Balance for USDT-FUTURES
   */
  static async getBalance(): Promise<any> {
    if (!isConfigured) {
      console.log("[Bitget Service] Using Mock Balance data.");
      return {
        usdtAmount: "10000.00",
        available: "9500.00",
        mock: true
      };
    }

    try {
      const path = "/api/v2/mix/account/accounts?productType=USDT-FUTURES";
      const headers = getHeaders("GET", path);
      const res = await axios.get(`${BASE_URL}${path}`, { headers });
      
      if (res.data && res.data.code === "00000") {
        return res.data.data;
      } else {
        throw new Error(res.data.msg || "Unknown Bitget API Error");
      }
    } catch (error: any) {
      console.error("[Bitget Service] getBalance error:", error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Get Current Positions
   */
  static async getPositions(): Promise<any[]> {
    if (!isConfigured) {
      console.log("[Bitget Service] Using Mock Positions data.");
      return [
        {
          symbol: "TSLAUSDT",
          productType: "USDT-FUTURES",
          side: "buy",
          marginMode: "isolated",
          holdQty: "10",
          openPrice: "178.50",
          marketPrice: "180.20",
          unrealizedPL: "17.00",
          mock: true
        }
      ];
    }

    try {
      const path = "/api/v2/mix/position/all-position?productType=USDT-FUTURES";
      const headers = getHeaders("GET", path);
      const res = await axios.get(`${BASE_URL}${path}`, { headers });

      if (res.data && res.data.code === "00000") {
        return res.data.data || [];
      } else {
        throw new Error(res.data.msg || "Unknown Bitget API Error");
      }
    } catch (error: any) {
      console.error("[Bitget Service] getPositions error:", error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Place Order
   */
  static async placeOrder(params: {
    symbol: string;
    side: "buy" | "sell";
    size: string;
    orderType: "market" | "limit";
    price?: string;
  }): Promise<any> {
    const { symbol, side, size, orderType, price } = params;

    if (!isConfigured) {
      console.log(`[Bitget Service] Executed Mock Order: ${side} ${size} contracts of ${symbol}`);
      return {
        orderId: `mock_order_${Math.floor(Math.random() * 1000000)}`,
        symbol,
        side,
        size,
        price: price || "Market Price",
        status: "SUCCESS",
        mock: true
      };
    }

    try {
      const path = "/api/v2/mix/order/place-order";
      const body = {
        symbol,
        productType: "USDT-FUTURES",
        marginCoin: "USDT",
        marginMode: "isolated",
        side,
        size,
        orderType,
        price: orderType === "limit" ? price : undefined
      };

      const headers = getHeaders("POST", path, body);
      const res = await axios.post(`${BASE_URL}${path}`, body, { headers });

      if (res.data && res.data.code === "00000") {
        return res.data.data;
      } else {
        throw new Error(res.data.msg || "Unknown Bitget API Error");
      }
    } catch (error: any) {
      console.error("[Bitget Service] placeOrder error:", error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Place TP/SL Order on Position
   */
  static async placeTPSL(params: {
    symbol: string;
    stopSurplusTriggerPrice?: string;
    stopLossTriggerPrice?: string;
    size: string;
  }): Promise<any> {
    const { symbol, stopSurplusTriggerPrice, stopLossTriggerPrice, size } = params;

    if (!isConfigured) {
      console.log(`[Bitget Service] Placed Mock TP/SL for ${symbol}: TP ${stopSurplusTriggerPrice || "None"}, SL ${stopLossTriggerPrice || "None"}`);
      return {
        status: "SUCCESS",
        mock: true
      };
    }

    try {
      const path = "/api/v2/mix/order/place-pos-tpsl";
      const body = {
        symbol,
        productType: "USDT-FUTURES",
        marginCoin: "USDT",
        stopSurplusTriggerPrice,
        stopSurplusSize: stopSurplusTriggerPrice ? size : undefined,
        stopLossTriggerPrice,
        stopLossSize: stopLossTriggerPrice ? size : undefined
      };

      const headers = getHeaders("POST", path, body);
      const res = await axios.post(`${BASE_URL}${path}`, body, { headers });

      if (res.data && res.data.code === "00000") {
        return res.data.data;
      } else {
        throw new Error(res.data.msg || "Unknown Bitget API Error");
      }
    } catch (error: any) {
      console.error("[Bitget Service] placeTPSL error:", error.response?.data || error.message);
      throw error;
    }
  }
}
