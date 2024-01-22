import { QuoteResponse } from '@jup-ag/api';
import { VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { defaultImport } from 'default-import';
import jsbi from 'jsbi';
import { config } from './config.js';
import {
  SOL_DECIMALS,
  USDC_DECIMALS,
  USDC_MINT_STRING
} from './constants.js';
import { logger } from './logger.js';
import { calculateJupiterBestQuote } from './markets/amm-calc.js';
import { SerializableLeg, SerializableLegFixed } from './markets/types.js';
import { BackrunnableTrade } from './post-simulation-filter.js';
import { JsbiType, Timings } from './types.js';
import { prioritize, toDecimalString } from './utils.js';

const JSBI = defaultImport(jsbi);

// const MAX_ARB_CALCULATION_TIME_MS = config.get('max_arb_calculation_time_ms');
const HIGH_WATER_MARK = 500;

const MINIMUM_SOL_TRADE_SIZE = JSBI.BigInt(config.get('min_sol_trade_size'));
const MINIMUM_USDC_TRADE_SIZE = JSBI.BigInt(config.get('min_usdc_trade_size'));
const MINIMUM_PRICE_IMPACT_PCT = config.get('min_price_impact_pct');

const USDC_SOL_PRICE = 100;
// ratio in lamports
// multiply by 1000 since USDC is 6 decimals and SOL is 9 decimals to get lamport for lamport equivalence
// then divice by SOL/USDC price to get USDC -> SOL ratio
export const LAMPORTS_PER_USDC_UNIT = Math.floor(1000 / USDC_SOL_PRICE)
const USDC_SOL_RATIO = BigInt(LAMPORTS_PER_USDC_UNIT);
export const MAX_TRADE_AGE_MS = 200;

export type ArbIdeaTrade = {
  in: JsbiType,
  out: JsbiType, // can ignore?
  tipBps: number,
  mirroringLegQuote: QuoteResponse,
  balancingLeg: SerializableLegFixed,
  balancingLegFirst: boolean
}

type ArbIdea = {
  txn: VersionedTransaction;
  expectedProfit: JsbiType;
  trade: ArbIdeaTrade
  timings: Timings;
};

async function* calculateArb(
  backrunnableTradesIterator: AsyncGenerator<BackrunnableTrade>,
): AsyncGenerator<ArbIdea> {
  // prioritize trades that are bigger as profit is esssentially bottlenecked by the trade size
  // for this compare the size of base token (sol or usdc). bcs they have diff amounts of decimals and value
  // normalize usdc by a factor
  const backrunnableTradesIteratorGreedyPrioritized = prioritize(
    backrunnableTradesIterator,
    (tradeA, tradeB) => {
      const tradeABaseMint = tradeA.baseIsTokenA
        ? tradeA.market.tokenMintA
        : tradeA.market.tokenMintB;
      const tradeBBaseMint = tradeB.baseIsTokenA
        ? tradeB.market.tokenMintA
        : tradeB.market.tokenMintB;
      const tradeAIsUsdc = tradeABaseMint === USDC_MINT_STRING;
      const tradeBisUsdc = tradeBBaseMint === USDC_MINT_STRING;
      const tradeASize = tradeA.baseIsTokenA
        ? tradeA.tradeSizeA
        : tradeA.tradeSizeB;
      const tradeASizeNormalized = tradeAIsUsdc
        ? tradeASize * USDC_SOL_RATIO
        : tradeASize;
      const tradeBSize = tradeB.baseIsTokenA
        ? tradeB.tradeSizeA
        : tradeB.tradeSizeB;
      const tradeBSizeNormalized = tradeBisUsdc
        ? tradeBSize * USDC_SOL_RATIO
        : tradeBSize;

      // our sorting is based on size of trade x impact of trade in SOL terms
      const tradeAImpact = tradeASizeNormalized * BigInt(Math.floor(tradeA.priceImpactPct * 10000))
      const tradeBImpact = tradeBSizeNormalized * BigInt(Math.floor(tradeB.priceImpactPct * 10000))

      if (tradeAImpact < tradeBImpact) {
        return 1;
      }

      if (tradeAImpact > tradeBImpact) {
        return -1;
      }
      // a must be equal to b
      return 0;
    },
    HIGH_WATER_MARK,
  );

  for await (const {
    txn,
    market: originalMarket,
    baseIsTokenA,
    tradeDirection: originalTradeDirection,
    tradeSizeA,
    tradeSizeB,
    timings,
    priceImpactPct
  } of backrunnableTradesIteratorGreedyPrioritized) {
    if (Date.now() - timings.mempoolEnd > MAX_TRADE_AGE_MS) {
      logger.debug(`Trade is too old, skipping`);
      continue;
    }

    logger.debug(`backrunnableTrade ${bs58.encode(txn.signatures[0]).slice(0, 4)}... \
on ${originalMarket.dexLabel} for ${originalMarket.tokenMintA.slice(0, 4)}.../${originalMarket.tokenMintB.slice(0, 4)}... \
${tradeSizeA}/${tradeSizeB} by ${txn.message.staticAccountKeys[0].toBase58()} \
with ${priceImpactPct.toFixed(3)}% price impact \
in ${timings.postSimEnd - timings.mempoolEnd}ms`);

    const tradeSizeBase = JSBI.BigInt(
      (baseIsTokenA ? tradeSizeA : tradeSizeB).toString(),
    );
    const tradeSizeQuote = JSBI.BigInt(
      (baseIsTokenA ? tradeSizeB : tradeSizeA).toString(),
    );

    // source mint is always usdc or sol
    const backrunSourceMint = baseIsTokenA
      ? originalMarket.tokenMintA
      : originalMarket.tokenMintB;

    const backrunIntermediateMint = baseIsTokenA
      ? originalMarket.tokenMintB
      : originalMarket.tokenMintA;

    // if they bought base (so usdc or sol) on the original market, it means there is less base now and more of the other token
    // which means the other token is now cheaper so we buy it first
    const balancingLegFirst = originalTradeDirection === 'BOUGHT_BASE';

    // this trade (once scaled) will be either the first leg or the last leg
    const balancingLeg: SerializableLegFixed = balancingLegFirst ? {
      marketId: originalMarket.id,
      dex: originalMarket.dexLabel,
      sourceMint: backrunSourceMint,
      destinationMint: backrunIntermediateMint,
      in: tradeSizeBase.toString(),
      estimatedOutExcludingFees: tradeSizeQuote.toString(),
    } : {
      marketId: originalMarket.id,
      dex: originalMarket.dexLabel,
      sourceMint: backrunIntermediateMint,
      destinationMint: backrunSourceMint,
      in: tradeSizeQuote.toString(),
      estimatedOutExcludingFees: tradeSizeBase.toString(),
    }

    // this trade is a mirror of the original victim trade, the opposite of the balancing trade
    const mirroringLeg: SerializableLeg = {
      sourceMint: balancingLeg.destinationMint,
      destinationMint: balancingLeg.sourceMint,
    }

    const sourceIsUsdc = USDC_MINT_STRING === backrunSourceMint;

    // skip if original trade size is too small
    if (sourceIsUsdc) {
      if (JSBI.lessThan(tradeSizeBase, MINIMUM_USDC_TRADE_SIZE)) {
        logger.info(`Skipping arb idea bcs trade size is too small`);
        continue;
      }
    } else {
      if (JSBI.lessThan(tradeSizeBase, MINIMUM_SOL_TRADE_SIZE)) {
        logger.info(`Skipping arb idea bcs trade size is too small`);
        continue;
      }
    }

    // skip if price impact is too small
    if (priceImpactPct < MINIMUM_PRICE_IMPACT_PCT) {
      logger.info(`Skipping arb idea bcs price impact is too small`);
      continue;
    }

    const bestQuoteResult = await calculateJupiterBestQuote(
      balancingLeg,
      mirroringLeg,
      balancingLegFirst,
      bs58.encode(txn.signatures[0]))

    if (!bestQuoteResult) continue;

    const { quote: bestQuote, profit } = bestQuoteResult;

    const profitBN = JSBI.BigInt(profit)

    const decimals = sourceIsUsdc ? USDC_DECIMALS : SOL_DECIMALS;
    const backrunSourceMintName = sourceIsUsdc ? 'USDC' : 'SOL';

    const profitDecimals = toDecimalString(profitBN.toString(), decimals);
    const arbSizeDecimals = toDecimalString(bestQuote.in.toString(), decimals);

    const marketsString = bestQuote.quote.routePlan.reduce((acc, r) => {
      return `${acc} -> ${r.swapInfo.label}`;
    }, balancingLeg.dex as string);

    logger.info(
      `Potential arb: profit ${profitDecimals} ${backrunSourceMintName} on ${originalMarket.dexLabel
      } ::: BUY ${arbSizeDecimals} on ${marketsString} backrunning ${bs58.encode(
        txn.signatures[0],
      )} tip ${bestQuote.tipBps} in ${Date.now() - timings.mempoolEnd}ms`,
    );

    yield {
      txn,
      expectedProfit: profitBN,
      trade: {
        in: bestQuote.in,
        out: bestQuote.out,
        tipBps: bestQuote.tipBps,
        mirroringLegQuote: bestQuote.quote,
        balancingLeg,
        balancingLegFirst
      },
      timings: {
        mempoolEnd: timings.mempoolEnd,
        preSimEnd: timings.preSimEnd,
        simEnd: timings.simEnd,
        postSimEnd: timings.postSimEnd,
        calcArbEnd: Date.now(),
        buildBundleEnd: 0,
        bundleSent: 0,
      },
    };
  }
}

export { ArbIdea, calculateArb };
