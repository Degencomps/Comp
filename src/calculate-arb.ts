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
import {
  calculateJupiterQuotes as workerCalculateJupiterQuotes
} from './markets/index.js';
import { Quote, SerializableLeg, SerializableLegFixed } from './markets/types.js';
import { BackrunnableTrade } from './post-simulation-filter.js';
import { JsbiType, Timings } from './types.js';
import { prioritize, toDecimalString } from './utils.js';

const JSBI = defaultImport(jsbi);

const ARB_CALCULATION_NUM_STEPS = config.get('arb_calculation_num_steps');
const MAX_ARB_CALCULATION_TIME_MS = config.get('max_arb_calculation_time_ms');
const HIGH_WATER_MARK = 500;

const USDC_SOL_PRICE = 100;
// ratio in lamports
// multiply by 1000 since USDC is 6 decimals and SOL is 9 decimals to get lamport for lamport equivalence
// then divice by SOL/USDC price to get USDC -> SOL ratio
const USDC_SOL_RATIO = BigInt(Math.floor(1000 / USDC_SOL_PRICE));
const MAX_TRADE_AGE_MS = 200;

type ArbIdea = {
  txn: VersionedTransaction;
  arbSize: JsbiType;
  expectedProfit: JsbiType;
  quote: Quote;
  timings: Timings;
};

function getProfitForQuote(quote: Quote) {
  return JSBI.subtract(quote.out, quote.in);
  // const flashloanFee = JSBI.divide(
  //   JSBI.multiply(quote.in, JSBI.BigInt(SOLEND_FLASHLOAN_FEE_BPS)),
  //   JSBI.BigInt(10000),
  // );
  // const profit = JSBI.subtract(quote.out, quote.in);
  // const profitMinusFlashLoanFee = JSBI.subtract(profit, flashloanFee);
  // return profitMinusFlashLoanFee;
}

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

    // calculate the arb calc step size and init initial arb size to it
    const stepSize = JSBI.divide(
      JSBI.divide(tradeSizeBase, JSBI.BigInt(2)), // never do more than 50% of the original trade size
      JSBI.BigInt(ARB_CALCULATION_NUM_STEPS), // now split it into a few steps
    );

    // ignore trade if minimum arb size is too small
    if (JSBI.equal(stepSize, JSBI.BigInt(0))) continue;

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

    const quotes = await workerCalculateJupiterQuotes({
      balancingLeg,
      mirroringLeg,
      balancingLegFirst
    }, MAX_ARB_CALCULATION_TIME_MS);

    if (quotes === null || quotes.length === 0) continue;

    logger.debug(`Found ${quotes.length} potential arbs for ${bs58.encode(txn.signatures[0]).slice(0, 4)}...`);
    // find the best quote
    const bestQuote = quotes.reduce((best, current) => {
      const currentQuote = current[1];
      const currentProfit = getProfitForQuote(currentQuote);
      const bestQuote = best[1];
      const bestProfit = getProfitForQuote(bestQuote);
      if (JSBI.greaterThan(currentProfit, bestProfit)) {
        return current;
      } else {
        return best;
      }
    });

    const profit = getProfitForQuote(bestQuote);
    const arbSize = bestQuote.in;

    const sourceIsUsdc = USDC_MINT_STRING === backrunSourceMint;
    const decimals = sourceIsUsdc ? USDC_DECIMALS : SOL_DECIMALS;
    const backrunSourceMintName = sourceIsUsdc ? 'USDC' : 'SOL';

    const profitDecimals = toDecimalString(profit.toString(), decimals);
    const arbSizeDecimals = toDecimalString(arbSize.toString(), decimals);

    const marketsString = bestQuote.quote.routePlan.reduce((acc, r) => {
      return `${acc} -> ${r.swapInfo.label}`;
    }, balancingLeg.dex as string);

    logger.info(
      `Potential arb: profit ${profitDecimals} ${backrunSourceMintName} on ${originalMarket.dexLabel
      } ::: BUY ${arbSizeDecimals} on ${marketsString} backrunning ${bs58.encode(
        txn.signatures[0],
      )} in ${Date.now() - timings.mempoolEnd}ms`,
    );

    yield {
      txn,
      arbSize,
      expectedProfit: profit,
      quote: bestQuote,
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
