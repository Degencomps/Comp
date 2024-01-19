import { Amm, ammFactory } from '@jup-ag/core';
import { AccountInfo, PublicKey } from '@solana/web3.js';
import { parentPort, workerData } from 'worker_threads';
import { jupiterClient } from '../clients/jupiter.js';
import { config } from '../config.js';
import { logger as loggerOrig } from '../logger.js';
import { JSBI, JsbiType } from '../types.js';
import { JupiterDexProgramLabel } from './jupiter/index.js';
import {
  AddPoolParamPayload,
  AmmCalcWorkerParamMessage,
  AmmCalcWorkerResultMessage,
  CalculateJupiterQuotesParamPayload,
  Quote,
  SerializableLeg,
  SerializableLegFixed,
} from './types.js';
import { toAccountInfo, toSerializableQuote } from './utils.js';

const ARB_CALCULATION_NUM_STEPS = JSBI.BigInt(config.get('arb_calculation_num_steps'));
const ZERO = JSBI.BigInt(0);
const TWO = JSBI.BigInt(2);
const SCALING_FACTOR = JSBI.BigInt(10000);
const BPS_MULTIPLIER = JSBI.BigInt(10000);

const workerId = workerData.workerId;

const logger = loggerOrig.child({ name: 'calc-worker' + workerId });

logger.info('AmmCalcWorker started');

const pools: Map<string, Amm> = new Map();
const accountsForUpdateForPool: Map<string, string[]> = new Map();
const ammsForAccount: Map<string, string[]> = new Map();
const ammIsInitialized: Map<string, boolean> = new Map();
const feeForAmm: Map<string, number> = new Map();

function addPool(
  poolLabel: JupiterDexProgramLabel,
  id: string,
  accountInfo: AccountInfo<Buffer>,
  feeRateBps: number,
  params?: any,
) {
  logger.trace(`Adding pool ${id} with label ${poolLabel}`);

  const response: AmmCalcWorkerResultMessage = {
    type: 'addPool',
    payload: {
      id,
      success: true,
      accountsForUpdate: []
    },
  };

  // this isn't even stricktly needed
  try {
    if (poolLabel !== 'Raydium CLMM') {
      const amm = ammFactory(new PublicKey(id), accountInfo, params);
      pools.set(id, amm);

      const accountsForUpdateWithDuplicates = amm
        .getAccountsForUpdate()
        .map((a) => a.toBase58());
      const accountsForUpdate = Array.from(
        new Set(accountsForUpdateWithDuplicates),
      );
      const needsAccounts = accountsForUpdate.length > 0;
      ammIsInitialized.set(id, !needsAccounts);
      accountsForUpdateForPool.set(id, accountsForUpdate);
      accountsForUpdate.forEach((a) => {
        const amms = ammsForAccount.get(a) || [];
        amms.push(id);
        ammsForAccount.set(a, amms);
      });

      response.payload.accountsForUpdate = accountsForUpdate;
    }
  } catch (e) {
    logger.error(`Failed to add pool ${poolLabel} ${id}`);
  }

  if (isNaN(feeRateBps)) {
    logger.warn(`Invalid fee rate for pool ${id}: ${feeRateBps}`)
  } else {
    feeForAmm.set(id, feeRateBps);
  }

  parentPort!.postMessage(response);
}

async function fetchJupiterQuote(sourceMint: string, destinationMint: string, amountIn: string, _excludeDexes: JupiterDexProgramLabel[]) {
  try {
    const quote = await jupiterClient.quoteGet({
      inputMint: sourceMint,
      outputMint: destinationMint,
      amount: Math.floor(parseFloat(amountIn)),
      slippageBps: 0,
      onlyDirectRoutes: true,
      asLegacyTransaction: true,
      excludeDexes: ["Perps", ..._excludeDexes]
    })

    return {
      in: JSBI.BigInt(quote.inAmount),
      out: JSBI.BigInt(quote.otherAmountThreshold),
      quote
    }
  } catch (e) {
    const url = `inputMint=${sourceMint}&outputMint=${destinationMint}&amount=${Math.floor(parseFloat(amountIn))}&slippageBps=0&onlyDirectRoutes=true`
    logger.warn('Failed to fetch Jupiter quote, try manually: ' + url)

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

function calculatedFixedLegQuotes(inputSteps: JsbiType[], balancingLeg: SerializableLegFixed): Omit<Quote, 'quote'>[] {
  return inputSteps
    .map(i => calculateFixedLegQuote(i, balancingLeg.marketId, JSBI.BigInt(balancingLeg.in), JSBI.BigInt(balancingLeg.estimatedOutExcludingFees)))
}

// TODO: add a min size filter
async function calculateJupiterQuotes(balancingLeg: SerializableLegFixed, mirroringLeg: SerializableLeg, balancingLegFirst: boolean) {
  const profitableQuotes: Quote[] = [];

  try {
    if (balancingLegFirst) {
      const inputBase = JSBI.divide(JSBI.BigInt(balancingLeg.in), TWO)
      const inputSteps = calculateSteppedInputs(inputBase, ARB_CALCULATION_NUM_STEPS);
      const balancingLegQuotes = calculatedFixedLegQuotes(inputSteps, balancingLeg);
      const mirroringLegQuotes = await Promise.all(balancingLegQuotes.map(q => fetchJupiterQuote(mirroringLeg.sourceMint, mirroringLeg.destinationMint, q.out.toString(), [balancingLeg.dex])))

      for (const [i, q] of balancingLegQuotes.entries()) {
        const mirroringLeg = mirroringLegQuotes[i]
        const profit = JSBI.subtract(mirroringLeg.out, q.in)
        if (JSBI.greaterThan(profit, ZERO)) {
          profitableQuotes.push({
            in: q.in,
            out: mirroringLeg.out,
            quote: mirroringLeg.quote
          })
        }
      }
    } else {
      const inputBase = JSBI.divide(JSBI.BigInt(balancingLeg.estimatedOutExcludingFees), TWO);
      const inputSteps = calculateSteppedInputs(inputBase, ARB_CALCULATION_NUM_STEPS);
      const mirroringLegQuotes = await Promise.all(inputSteps.map(i => fetchJupiterQuote(mirroringLeg.sourceMint, mirroringLeg.destinationMint, i.toString(), [balancingLeg.dex])))
      const balancingLegQuotes = calculatedFixedLegQuotes(mirroringLegQuotes.map(q => q?.out), balancingLeg)

      for (const [i, q] of balancingLegQuotes.entries()) {
        const mirroringLeg = mirroringLegQuotes[i]
        const profit = JSBI.subtract(q.out, mirroringLeg.in)
        if (JSBI.greaterThan(profit, ZERO)) {
          profitableQuotes.push({
            in: mirroringLeg.in,
            out: q.out,
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
  // build and sign a bundle for that quote

  const response: AmmCalcWorkerResultMessage = {
    type: 'calculateJupiterQuotes',
    payload: {
      quotes: profitableQuotes.map(toSerializableQuote),
    },
  }

  parentPort!.postMessage(response);
}

parentPort.on('message', (message: AmmCalcWorkerParamMessage) => {
  switch (message.type) {
    case 'addPool': {
      const { poolLabel, id, serializableAccountInfo, feeRateBps, params } =
        message.payload as AddPoolParamPayload;
      const accountInfo = toAccountInfo(serializableAccountInfo);
      addPool(poolLabel, id, accountInfo, feeRateBps, params);
      break;
    }
    case 'calculateJupiterQuotes': {
      const { balancingLeg, mirroringLeg, balancingLegFirst } =
        message.payload as CalculateJupiterQuotesParamPayload;
      try {
        calculateJupiterQuotes(balancingLeg, mirroringLeg, balancingLegFirst);
      } catch (e) {
        logger.error(e, 'Failed to calculate Jupiter quotes')
      }
      break;
    }
  }
});
