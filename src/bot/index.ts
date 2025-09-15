import axios from "axios";
import * as dotenv from "dotenv";
import Table from "cli-table3";

dotenv.config();

type Token = "USDC" | "WETH" | "DAI";

type SimulationInput = {
  startToken: Token;
  sizesEur: number[]; // in EUR
  eurUsd: number; // EUR->USD rate
  dexFeePerSwapBps: number; // e.g., 30 = 0.30%
  aaveFeeBps: number; // e.g., 5 = 0.05%
};

type PricesUSD = Record<Token, number>; // token price in USD

async function fetchPricesUSD(): Promise<PricesUSD> {
  // CoinGecko simple price for polygon tokens (assume main asset prices)
  // USDC ~ $1, DAI ~$1, WETH ~ ETH price
  const ids = ["ethereum", "usd-coin", "dai"].join(",");
  const vs = "usd";
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=${vs}`;
  const { data } = await axios.get(url, { timeout: 10000 });
  const weth = Number(data["ethereum"]?.["usd"]) || 0;
  const usdc = Number(data["usd-coin"]?.["usd"]) || 1;
  const dai = Number(data["dai"]?.["usd"]) || 1;
  return { WETH: weth, USDC: usdc, DAI: dai };
}

function simulateTriangularCycle(
  startToken: Token,
  startAmountStartToken: number,
  prices: PricesUSD,
  dexFeePerSwapBps: number,
  aaveFeeBps: number
): { endAmountStartToken: number; gross: number; fees: number; net: number } {
  // Route: USDC -> WETH -> DAI -> USDC (or rotated if start is different)
  const route: Token[] = ["USDC", "WETH", "DAI", "USDC"];
  const startIndex = route.indexOf(startToken);
  const ordered = [
    route[startIndex],
    route[(startIndex + 1) % 4],
    route[(startIndex + 2) % 4],
    route[(startIndex + 3) % 4],
  ] as Token[];

  const dexFee = (amount: number) => amount * (dexFeePerSwapBps / 10000);
  const aaveFee = (amount: number) => amount * (aaveFeeBps / 10000);

  // Convert using USD mid prices; approximate
  // amount in token A -> USD -> token B, minus per-swap fee
  const swap = (amountIn: number, from: Token, to: Token): number => {
    const amountUsd = amountIn * prices[from];
    const amountOut = amountUsd / prices[to];
    const fee = dexFee(amountOut);
    return Math.max(amountOut - fee, 0);
  };

  let amount = startAmountStartToken;
  let totalDexFees = 0;
  // 3 swaps
  for (let i = 0; i < 3; i++) {
    const from = ordered[i];
    const to = ordered[i + 1];
    const before = amount;
    amount = swap(amount, from, to);
    totalDexFees += Math.max(before * prices[from] / prices[to] - amount, 0) * prices[to] / prices[to];
  }

  // Flash loan fee on start token notionally
  const flFee = aaveFee(startAmountStartToken);
  const endAmount = amount;
  const gross = endAmount - startAmountStartToken;
  const totalFees = flFee + (totalDexFees || 0);
  const net = gross - flFee; // dex fee already taken in swap result

  return { endAmountStartToken: endAmount, gross, fees: totalFees, net };
}

async function main() {
  const sizesEurEnv = process.env.SIZES_EUR || "100000,500000,1000000";
  const sizesEur = sizesEurEnv.split(",").map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n));
  const eurUsd = Number(process.env.EUR_USD || "1.07");
  const dexFeeBps = Number(process.env.DEX_FEE_BPS || "30");
  const aaveFeeBps = Number(process.env.AAVE_FEE_BPS || "5"); // 0.05%
  const startToken: Token = (process.env.START_TOKEN as Token) || "USDC";

  const prices = await fetchPricesUSD();

  const table = new Table({
    head: ["Size (EUR)", "Start Token", "Start Amount", "End Amount", "Gross", "Fees", "Net"],
    style: { head: [], border: [] }
  });

  for (const sizeEur of sizesEur) {
    const sizeUsd = sizeEur * eurUsd;
    const startAmountToken = sizeUsd / prices[startToken];
    const { endAmountStartToken, gross, fees, net } = simulateTriangularCycle(
      startToken,
      startAmountToken,
      prices,
      dexFeeBps,
      aaveFeeBps
    );

    table.push([
      sizeEur.toLocaleString("fr-FR"),
      startToken,
      startAmountToken.toFixed(4),
      endAmountStartToken.toFixed(4),
      gross.toFixed(4),
      fees.toFixed(4),
      net.toFixed(4),
    ]);
  }

  console.log("Triangular simulation (prices via CoinGecko, fees approx):");
  console.log(table.toString());
  console.log("Note: This is a high-level estimate. On-chain quotes, slippage, and gas differ.");
}

main().catch((err) => {
  console.error("Bot error:", err);
  process.exit(1);
});

