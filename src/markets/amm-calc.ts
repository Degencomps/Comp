import { AccountInfo } from '@solana/web3.js';
import { jupiterClient } from '../clients/jupiter.js';
import { config } from '../config.js';
import { BASE_MINTS_OF_INTEREST_B58 } from "../constants.js";
import { logger } from '../logger.js';
import { JSBI, JsbiType } from '../types.js';
import { JupiterDexProgramLabel } from './jupiter/index.js';
import {
  Quote,
  SerializableLeg,
  SerializableLegFixed
} from './types.js';

const ARB_CALCULATION_NUM_STEPS = JSBI.BigInt(config.get('arb_calculation_num_steps'));
const ZERO = JSBI.BigInt(0);
const TWO = JSBI.BigInt(2);
const SCALING_FACTOR = JSBI.BigInt(10000);
const BPS_MULTIPLIER = JSBI.BigInt(10000);

const MAX_USDC_BALANCE = 1200 * 10 ** 6
const MAX_SOL_BALANCE = 12 * 10 ** 9

//const INCLUDED_DEXES: JupiterDexProgramLabel[] = ['Lifinity V2', 'Whirlpool', 'Raydium', 'Raydium CLMM', 'Meteora DLMM', 'Mercurial']

// const pools: Map<string, Amm> = new Map();
// const accountsForUpdateForPool: Map<string, string[]> = new Map();
// const ammsForAccount: Map<string, string[]> = new Map();
// const ammIsInitialized: Map<string, boolean> = new Map();
const feeForAmm: Map<string, number> = new Map();

export function addPool(
  poolLabel: JupiterDexProgramLabel,
  id: string,
  _accountInfo: AccountInfo<Buffer>,
  feeRateBps: number,
  _params?: any,
) {
  logger.trace(`Adding pool ${id} with label ${poolLabel}`);

  const accountsForUpdate: string[] = [];

  // // this isn't even stricktly needed
  // try {
  //   if (poolLabel !== 'Raydium CLMM') {
  //     const amm = ammFactory(new PublicKey(id), accountInfo, params);
  //     pools.set(id, amm);

  //     const accountsForUpdateWithDuplicates = amm
  //       .getAccountsForUpdate()
  //       .map((a) => a.toBase58());
  //     accountsForUpdate = Array.from(
  //       new Set(accountsForUpdateWithDuplicates),
  //     );
  //     const needsAccounts = accountsForUpdate.length > 0;
  //     ammIsInitialized.set(id, !needsAccounts);
  //     accountsForUpdateForPool.set(id, accountsForUpdate);
  //     accountsForUpdate.forEach((a) => {
  //       const amms = ammsForAccount.get(a) || [];
  //       amms.push(id);
  //       ammsForAccount.set(a, amms);
  //     });
  //   }
  // } catch (e) {
  //   logger.error(`Failed to add pool ${poolLabel} ${id}`);
  // }

  if (isNaN(feeRateBps)) {
    logger.warn(`Invalid fee rate for pool ${id}: ${feeRateBps}`)
  } else {
    feeForAmm.set(id, feeRateBps);
  }

  return {
    success: true,
    accountsForUpdate
  }
}

async function fetchJupiterQuote(sourceMint: string, destinationMint: string, amountIn: string, _excludeDexes: JupiterDexProgramLabel[]) {
  try {
    const quote = await jupiterClient.quoteGet({
      inputMint: sourceMint,
      outputMint: destinationMint,
      amount: Math.floor(parseFloat(amountIn)),
      slippageBps: 0,
      onlyDirectRoutes: true,
      asLegacyTransaction: false,
      //dexes: INCLUDED_DEXES
      excludeDexes: ["Perps", "GooseFX"]
    })

    return {
      in: JSBI.BigInt(quote.inAmount),
      out: JSBI.BigInt(quote.otherAmountThreshold),
      quote
    }
  } catch (e) {
    const url = `inputMint=${sourceMint}&outputMint=${destinationMint}&amount=${Math.floor(parseFloat(amountIn))}&slippageBps=0&onlyDirectRoutes=true`
    logger.debug('Failed to fetch Jupiter quote, try manually: ' + url)

    return {
      in: ZERO, out: ZERO
    }
  }
}

function calculateFixedLegQuote(input: JsbiType, marketId: string, originalIn: JsbiType, originalOutExcludingFees: JsbiType) {
  if (JSBI.equal(input, ZERO)) return { in: ZERO, out: ZERO }

  if (!feeForAmm.has(marketId)) {
    logger.error(`No fee for market ${marketId}`)
    return { in: ZERO, out: ZERO }
  }

  const feeRateBps = feeForAmm.get(marketId) * 2;

  const originalOutputAfterFees = JSBI.subtract(
    originalOutExcludingFees,
    JSBI.divide(
      JSBI.multiply(originalOutExcludingFees, JSBI.BigInt(feeRateBps)),
      BPS_MULTIPLIER,
    ),
  );


  // Scale the amounts before the calculation
  // If overrideOutputAmount is significantly larger than overrideInputAmount and amount is small,
  // the result of JSBI.multiply(amount, overrideOutputAmount) can be significantly smaller than overrideInputAmount.
  const scaledInput = JSBI.multiply(input, SCALING_FACTOR);
  const scaledOriginalInput = JSBI.multiply(originalIn, SCALING_FACTOR)
  const scaledOriginalOutput = JSBI.multiply(
    originalOutputAfterFees,
    SCALING_FACTOR,
  );

  // Calculate the output for the current input amount based on the same ratio as the override
  let output = JSBI.divide(
    JSBI.multiply(scaledInput, scaledOriginalOutput),
    scaledOriginalInput,
  );

  // Scale the result back down after the calculation
  output = JSBI.divide(output, SCALING_FACTOR);

  return {
    in: input,
    out: output
  }
}

function calculateSteppedInputs(inputBase: JsbiType, steps: JsbiType): JsbiType[] {
  const stepSize = JSBI.divide(inputBase, steps)
  return new Array(steps).map((_, i) => JSBI.add(inputBase, JSBI.multiply(stepSize, JSBI.BigInt(i))));
}

function calculatedFixedLegQuotes(inputSteps: JsbiType[], balancingLeg: SerializableLegFixed): Omit<Quote, 'quote' | 'tipBps'>[] {
  return inputSteps
    .map(i => calculateFixedLegQuote(i, balancingLeg.marketId, JSBI.BigInt(balancingLeg.in), JSBI.BigInt(balancingLeg.estimatedOutExcludingFees)))
}

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

function getTipBpsFromInAmount(inAmount: JsbiType, sourceMint: string) {
  // tipping base on the balancing in TODO: improve this from analysis
  let tipBps = 5300
  if (sourceMint === BASE_MINTS_OF_INTEREST_B58.SOL) {
    if (JSBI.greaterThan(inAmount, JSBI.BigInt(1_000_000_000))) {
      tipBps = 6300
    }
    if (JSBI.greaterThan(inAmount, JSBI.BigInt(2_000_000_000))) {
      tipBps = 7300
    }
    if (JSBI.greaterThan(inAmount, JSBI.BigInt(3_000_000_000))) {
      tipBps = 8550
    }
  } else if (sourceMint === BASE_MINTS_OF_INTEREST_B58.USDC) {
    if (JSBI.greaterThan(inAmount, JSBI.BigInt(100_000_000))) {
      tipBps = 6300
    }
    if (JSBI.greaterThan(inAmount, JSBI.BigInt(200_000_000))) {
      tipBps = 7300
    }
    if (JSBI.greaterThan(inAmount, JSBI.BigInt(300_000_000))) {
      tipBps = 8550
    }
  }

  return tipBps
}

export async function calculateJupiterBestQuote(balancingLeg: SerializableLegFixed, mirroringLeg: SerializableLeg, balancingLegFirst: boolean, victimTxnSignature: string) {
  const profitableQuotes: Quote[] = [];

  try {
    if (balancingLegFirst) {
      let inputBase = JSBI.divide(JSBI.BigInt(balancingLeg.in), TWO)

      // cap at max balance
      if (balancingLeg.sourceMint === BASE_MINTS_OF_INTEREST_B58.SOL) {
        inputBase = JSBI.BigInt(Math.min(MAX_SOL_BALANCE, JSBI.toNumber(inputBase)))
      } else if (balancingLeg.sourceMint === BASE_MINTS_OF_INTEREST_B58.USDC) {
        inputBase = JSBI.BigInt(Math.min(MAX_USDC_BALANCE, JSBI.toNumber(inputBase)))
      }

      const inputSteps = calculateSteppedInputs(inputBase, ARB_CALCULATION_NUM_STEPS);
      const balancingLegQuotes = calculatedFixedLegQuotes(inputSteps, balancingLeg);
      const mirroringLegQuotes = await Promise.all(balancingLegQuotes.map(q => fetchJupiterQuote(mirroringLeg.sourceMint, mirroringLeg.destinationMint, q.out.toString(), [balancingLeg.dex])))

      // tipping base on the balancing in TODO: improve this from analysis
      const tipBps = getTipBpsFromInAmount(JSBI.BigInt(balancingLeg.in), balancingLeg.sourceMint)

      for (const [i, q] of balancingLegQuotes.entries()) {
        const mirroringLeg = mirroringLegQuotes[i]
        const profit = JSBI.subtract(mirroringLeg.out, q.in)

        if (JSBI.greaterThan(profit, ZERO)) {
          profitableQuotes.push({
            in: q.in,
            out: mirroringLeg.out,
            tipBps,
            quote: mirroringLeg.quote
          })
        }
      }
    } else {
      let inputBase = JSBI.divide(JSBI.BigInt(balancingLeg.estimatedOutExcludingFees), TWO);

      // cap at max balance
      if (balancingLeg.destinationMint === BASE_MINTS_OF_INTEREST_B58.SOL) {
        inputBase = JSBI.BigInt(Math.min(MAX_SOL_BALANCE, JSBI.toNumber(inputBase)))
      } else if (balancingLeg.destinationMint === BASE_MINTS_OF_INTEREST_B58.USDC) {
        inputBase = JSBI.BigInt(Math.min(MAX_USDC_BALANCE, JSBI.toNumber(inputBase)))
      }

      const inputSteps = calculateSteppedInputs(inputBase, ARB_CALCULATION_NUM_STEPS);
      const mirroringLegQuotes = await Promise.all(inputSteps.map(i => fetchJupiterQuote(mirroringLeg.sourceMint, mirroringLeg.destinationMint, i.toString(), [balancingLeg.dex])))
      const balancingLegQuotes = calculatedFixedLegQuotes(mirroringLegQuotes.map(q => q?.out), balancingLeg)

      // tipping base on the balancing estimatedOutExcludingFees TODO: improve this from analysis
      const tipBps = getTipBpsFromInAmount(JSBI.BigInt(balancingLeg.estimatedOutExcludingFees), balancingLeg.destinationMint)

      for (const [i, q] of balancingLegQuotes.entries()) {
        const mirroringLeg = mirroringLegQuotes[i]
        const profit = JSBI.subtract(q.out, mirroringLeg.in)
        if (JSBI.greaterThan(profit, ZERO)) {
          profitableQuotes.push({
            in: mirroringLeg.in,
            out: q.out,
            tipBps,
            quote: mirroringLeg.quote
          })
        }
      }
    }
  } catch (e) {
    logger.error(e, 'Failed to calculate quotes')
  }

  // TODO:
  // get the most profitable quote only
  // filter out trades that are too small
  // dynamic tipping bps based on expected profit

  if (profitableQuotes.length === 0) {
    return undefined;
  }

  logger.debug(`Found ${profitableQuotes.length} potential arbs for ${victimTxnSignature.slice(0, 4)}...`);
  // find the best quote
  const bestQuote = profitableQuotes.reduce((best, current) => {
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

  return {
    quote: bestQuote, profit
  }
}
