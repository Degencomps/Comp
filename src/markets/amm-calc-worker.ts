import { Amm, ammFactory } from '@jup-ag/core';
import { AccountInfo, PublicKey } from '@solana/web3.js';
import { parentPort, workerData } from 'worker_threads';
import { logger as loggerOrig } from '../logger.js';
import { JupiterDexProgramLabel } from './jupiter/index.js';
import {
  AddPoolParamPayload,
  AmmCalcWorkerParamMessage,
  AmmCalcWorkerResultMessage,
} from './types.js';
import { toAccountInfo } from './utils.js';

// const JSBI = defaultImport(jsbi);

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

  feeForAmm.set(id, feeRateBps);

  const message: AmmCalcWorkerResultMessage = {
    type: 'addPool',
    payload: {
      id,
      accountsForUpdate,
    },
  };

  parentPort!.postMessage(message);
}

// async function calculateRoute(route: SerializableRoute) {
//   logger.trace(route, `Calculating route`);
//   let amount = JSBI.BigInt(route[0].amount);
//   let firstIn: JsbiType | null = null;
//   for (const hop of route) {
//     if (hop.tradeOutputOverride !== null) {
//       const tradeOutputOverride = hop.tradeOutputOverride;
//       const overrideInputAmount = JSBI.BigInt(tradeOutputOverride.in);
//       const overrideOutputAmountWithoutFees = JSBI.BigInt(
//         tradeOutputOverride.estimatedOut,
//       );

//       // subtract fees in both directions (the original trade & the backrun trade)
//       const fee = feeForAmm.get(hop.marketId) * 2;
//       const overrideOutputAmount = JSBI.subtract(
//         overrideOutputAmountWithoutFees,
//         JSBI.divide(
//           JSBI.multiply(overrideOutputAmountWithoutFees, JSBI.BigInt(fee)),
//           JSBI.BigInt(10000),
//         ),
//       );

//       if (!firstIn) firstIn = amount;

//       const scalingFactor = JSBI.BigInt(10000);

//       // Scale the amounts before the calculation
//       // If overrideOutputAmount is significantly larger than overrideInputAmount and amount is small,
//       // the result of JSBI.multiply(amount, overrideOutputAmount) can be significantly smaller than overrideInputAmount.
//       const scaledAmount = JSBI.multiply(amount, scalingFactor);
//       const scaledOverrideOutputAmount = JSBI.multiply(
//         overrideOutputAmount,
//         scalingFactor,
//       );

//       // Calculate the output for the current input amount based on the same ratio as the override
//       amount = JSBI.divide(
//         JSBI.multiply(scaledAmount, scaledOverrideOutputAmount),
//         JSBI.multiply(overrideInputAmount, scalingFactor),
//       );

//       // Scale the result back down after the calculation
//       amount = JSBI.divide(amount, scalingFactor);

//       continue;
//     }
//     const quoteParams: QuoteParams = {
//       amount,
//       swapMode: SwapMode.ExactIn,
//       sourceMint: new PublicKey(hop.sourceMint),
//       destinationMint: new PublicKey(hop.destinationMint),
//     };
//     const amm = pools.get(hop.marketId);
//     const quote = calculateHop(amm, quoteParams);
//     amount = quote.out;
//     if (!firstIn) firstIn = quote.in;
//     if (JSBI.equal(amount, JSBI.BigInt(0))) break;
//   }

//   const message: AmmCalcWorkerResultMessage = {
//     type: 'calculateRoute',
//     payload: {
//       quote: { in: firstIn!.toString(), out: amount.toString() },
//     },
//   };

//   return message;
// }

parentPort.on('message', (message: AmmCalcWorkerParamMessage) => {
  switch (message.type) {
    case 'addPool': {
      const { poolLabel, id, serializableAccountInfo, feeRateBps, params } =
        message.payload as AddPoolParamPayload;
      const accountInfo = toAccountInfo(serializableAccountInfo);
      addPool(poolLabel, id, accountInfo, feeRateBps, params);
      break;
    }
  }
});
