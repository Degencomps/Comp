import { parentPort, workerData } from "worker_threads";
import {
  AddPoolParamPayload,
  BestQuote,
  DEX,
  Market, Quote,
  SerializableLeg,
  SerializableLegFixed
} from "./markets/types.js";
import { logger as loggerOrig } from "./logger.js";
import {
  AccountInfo,
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  MessageAccountKeys,
  PublicKey,
  RpcResponseAndContext,
  SimulatedTransactionAccountInfo,
  SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction, TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { BASE_MINTS_OF_INTEREST_B58, SOL_DECIMALS, USDC_DECIMALS, USDC_MINT_STRING } from "./constants.js";
import { SplTokenSwapDEX } from "./markets/spl-token-swap/index.js";
import { OrcaWhirpoolDEX } from "./markets/orca-whirlpool/index.js";
import { RaydiumDEX } from "./markets/raydium/index.js";
import { RaydiumClmmDEX } from "./markets/raydium-clmm/index.js";
import { MintMarketGraph } from "./markets/market-graph.js";
import { JupiterDexProgramLabel } from "./markets/jupiter/index.js";
import { Amm, ammFactory } from "@jup-ag/core";
import { toAccountInfo } from "./markets/utils.js";
import { BotWorkerParamMessage, FilteredTransaction, JsbiType, MempoolUpdate, Timings } from "./types.js";
import { SimulatedBundleResponse } from "jito-ts";
import { lookupTableProvider } from "./lookup-table-provider.js";
import { connection } from "./clients/rpc.js";
import EventEmitter from "events";
import { Queue } from "@datastructures-js/queue";
import * as Token from "@solana/spl-token-3";
import { dropBeyondHighWaterMark, prioritize, toDecimalString } from "./utils.js";
import bs58 from "bs58";
import jsbi from "jsbi";
import { config } from "./config.js";
import { Instruction, QuoteResponse, RoutePlanStep, SwapInstructionsResponse, SwapMode } from "@jup-ag/api";
import { jupiterClient } from "./clients/jupiter.js";
import fs from "fs";
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { IDL as JitoBomb } from "./clients/types/jito_bomb.js";
import { Buffer } from "buffer";
import {
  createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT
} from "@solana/spl-token-3";
import BN from "bn.js";
import { defaultImport } from "default-import";

const workerId = workerData.workerId;
export const logger = loggerOrig.child({ name: 'bot-worker' + workerId });

logger.info(`BotWorker ${workerId} started`);

const dexs: DEX[] = [
  new SplTokenSwapDEX(),
  new OrcaWhirpoolDEX(),
  new RaydiumDEX(),
  new RaydiumClmmDEX(),
];

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
    }
  } catch (e) {
    logger.error(`Failed to add pool ${poolLabel} ${id}`);
  }

  if (isNaN(feeRateBps)) {
    logger.warn(`Invalid fee rate for pool ${id}: ${feeRateBps}`)
  } else {
    feeForAmm.set(id, feeRateBps);
  }
}

for (const dex of dexs) {
  for (const addPoolMessage of dex.getAmmCalcAddPoolMessages()) {
    const { poolLabel, id, serializableAccountInfo, feeRateBps, params } =
      addPoolMessage.payload as AddPoolParamPayload;
    const accountInfo = toAccountInfo(serializableAccountInfo);
    addPool(poolLabel, id, accountInfo, feeRateBps, params);
  }
}

// both vaults of all markets where one side of the market is USDC or SOL
const tokenAccountsOfInterest = new Map<string, Market>();
const marketGraph = new MintMarketGraph();

// dynamically get tokens of interest
// token has at least a direct swap against USDC or SOL
// token has at least another swap in the markets
const tokensOfInterestMap = new Map<string, number>();

const incrementMint = (mint: string) => {
  if (tokensOfInterestMap.has(mint)) {
    tokensOfInterestMap.set(mint, tokensOfInterestMap.get(mint) + 1);
  } else {
    tokensOfInterestMap.set(mint, 1);
  }
};

for (const dex of dexs) {
  for (const market of dex.getAllMarkets()) {
    incrementMint(market.tokenMintA);
    incrementMint(market.tokenMintB);
  }
}

// filter map key and put in set
const ignoredTokens = new Set(
  Array.from(tokensOfInterestMap.keys()).filter(
    (key) => tokensOfInterestMap.get(key) <= 1,
  ),
);

logger.info('Number of tokens to ignore: ' + ignoredTokens.size);

for (const dex of dexs) {
  for (const market of dex.getAllMarkets()) {
    const isMarketOfInterest =
      market.tokenMintA == BASE_MINTS_OF_INTEREST_B58.USDC ||
      market.tokenMintA == BASE_MINTS_OF_INTEREST_B58.SOL ||
      market.tokenMintB == BASE_MINTS_OF_INTEREST_B58.USDC ||
      market.tokenMintB == BASE_MINTS_OF_INTEREST_B58.SOL;

    // filter tokens of interest
    const isIgnoredToken =
      ignoredTokens.has(market.tokenMintA) ||
      ignoredTokens.has(market.tokenMintB);

    if (isMarketOfInterest && !isIgnoredToken) {
      tokenAccountsOfInterest.set(market.tokenVaultA, market);
      tokenAccountsOfInterest.set(market.tokenVaultB, market);

      marketGraph.addMarket(market.tokenMintA, market.tokenMintB, market);
    }
  }
}

export const isTokenAccountOfInterest = (tokenAccount: string): boolean => {
  return tokenAccountsOfInterest.has(tokenAccount);
};

function getMarketForVault(vault: string): Market | undefined {
  const market = tokenAccountsOfInterest.get(vault);

  if (market === undefined) {
    logger.warn(`No market found for vault ${vault}`);
    return undefined;
  }

  return market;
}


const MAX_MEMPOOL_AGE_MS = 100;
const SKIP_TX_IF_CONTAINS_ADDRESS = [
  '882DFRCi5akKFyYxT4PP2vZkoQEGvm2Nsind2nPDuGqu', // orca whirlpool mm whose rebalancing txns mess with the calc down the line and is no point in backrunning
];

async function* preSimulationFilter(
  mempoolUpdate: MempoolUpdate
): AsyncGenerator<FilteredTransaction> {

  const { txn: txnBuffer, timings } = mempoolUpdate;

  const age = Date.now() - timings.mempoolEnd;
  if (age > MAX_MEMPOOL_AGE_MS) {
    logger.debug(`Skipping mempool entry - age: ${age}ms`);
    return
  }

  const txn = VersionedTransaction.deserialize(txnBuffer);

  const addressLookupTableAccounts: AddressLookupTableAccount[] = [];

  for (const lookup of txn.message.addressTableLookups) {
    const lut = await lookupTableProvider.getLookupTable(lookup.accountKey);
    if (lut === null) {
      break;
    }
    addressLookupTableAccounts.push(lut);
  }

  let accountKeys: MessageAccountKeys | null = null;
  try {
    accountKeys = txn.message.getAccountKeys({
      addressLookupTableAccounts,
    });
  } catch (e) {
    logger.warn(`Address not in lookup table, refreshing`);
    await Promise.all(txn.message.addressTableLookups.map(l => lookupTableProvider.getLookupTable(l.accountKey, true)))
  }
  const accountsOfInterest = new Set<string>();

  let skipTx = false;
  for (const key of accountKeys?.keySegments().flat() ?? []) {
    const keyStr = key.toBase58();
    if (SKIP_TX_IF_CONTAINS_ADDRESS.includes(keyStr)) {
      skipTx = true;
      break;
    }
    if (isTokenAccountOfInterest(keyStr)) {
      accountsOfInterest.add(keyStr);
    }
  }

  if (skipTx) return;
  if (accountsOfInterest.size === 0) return;

  logger.debug(
    `Found txn with ${accountsOfInterest.size} accounts of interest`,
  );

  yield {
    txn,
    accountsOfInterest: [...accountsOfInterest],
    timings: {
      mempoolEnd: timings.mempoolEnd,
      preSimEnd: Date.now(),
      simEnd: 0,
      postSimEnd: 0,
      calcArbEnd: 0,
      buildBundleEnd: 0,
      bundleSent: 0,
    },
  };
}

// drop slow sims - usually a sign of high load
const MAX_SIMULATION_AGE_MS = 200; // TODO: change this back to 200
const MAX_PENDING_SIMULATIONS = 1000;
const RECEIVED_SIMULATION_RESULT_EVENT = 'receivedSimulationResult';

type SimulationResult = {
  txn: VersionedTransaction;
  response: RpcResponseAndContext<SimulatedBundleResponse>;
  accountsOfInterest: string[];
  timings: Timings;
};

let pendingSimulations = 0;

const simulationResults: Queue<{
  txn: VersionedTransaction;
  response: RpcResponseAndContext<SimulatedBundleResponse> | null;
  accountsOfInterest: string[];
  timings: Timings;
}> = new Queue();


async function sendSimulations(
  txnIterator: AsyncGenerator<FilteredTransaction>,
  eventEmitter: EventEmitter,
) {
  for await (const { txn, accountsOfInterest, timings } of txnIterator) {
    if (pendingSimulations > MAX_PENDING_SIMULATIONS) {
      logger.debug(
        'dropping txn due to high pending simulation count: ' +
        pendingSimulations,
      );
      continue;
    }

    // using jito-solana simulateBundle because unlike simulateTransaction
    // it returns the before AND after account states
    // we need both to find out the trade size and direction
    const sim = connection.simulateBundle([txn], {
      preExecutionAccountsConfigs: [
        { addresses: accountsOfInterest, encoding: 'base64' },
      ],
      postExecutionAccountsConfigs: [
        { addresses: accountsOfInterest, encoding: 'base64' },
      ],
      simulationBank: 'tip',
      replaceRecentBlockhash: true,
      skipSigVerify: true
    });
    pendingSimulations += 1;
    sim
      .then((res) => {
        simulationResults.push({
          txn,
          response: res,
          accountsOfInterest,
          timings,
        });
      })
      .catch((e) => {
        // ignore the too many account locks error
        const message = e.message as string
        if (!message.includes('TooManyAccountLocks') && !message.includes('AccountLoadedTwice')) {
          logger.error({ message: e.message }, "Error simulating bundle");
        }
        simulationResults.push({
          txn,
          response: null,
          accountsOfInterest,
          timings,
        });

      }).finally(() => {
      pendingSimulations -= 1;
      eventEmitter.emit(RECEIVED_SIMULATION_RESULT_EVENT);
    });
  }
}

async function* simulate(
  txnIterator: AsyncGenerator<FilteredTransaction>,
): AsyncGenerator<SimulationResult> {
  const eventEmitter = new EventEmitter();
  sendSimulations(txnIterator, eventEmitter);

  while (true) {
    if (simulationResults.size() === 0) {
      await new Promise((resolve) =>
        eventEmitter.once(RECEIVED_SIMULATION_RESULT_EVENT, resolve),
      );
    }

    const { txn, response, accountsOfInterest, timings } =
      simulationResults.dequeue();
    logger.debug(`Simulation took ${Date.now() - timings.preSimEnd}ms`);
    const txnAge = Date.now() - timings.mempoolEnd;

    if (txnAge > MAX_SIMULATION_AGE_MS) {
      logger.debug(`dropping slow simulation - age: ${txnAge}ms`);
      continue;
    }

    if (response !== null) {
      yield {
        txn,
        response,
        accountsOfInterest,
        timings: {
          mempoolEnd: timings.mempoolEnd,
          preSimEnd: timings.preSimEnd,
          simEnd: Date.now(),
          postSimEnd: 0,
          calcArbEnd: 0,
          buildBundleEnd: 0,
          bundleSent: 0,
        },
      };
    }
  }
}

const MIN_PRICE_IMPACT_PCT_FILTER = 0.1;

enum TradeDirection {
  SOLD_BASE = 'SOLD_BASE',
  BOUGHT_BASE = 'BOUGHT_BASE',
}

type BackrunnableTrade = {
  txn: VersionedTransaction;
  market: Market;
  baseIsTokenA: boolean;
  tradeDirection: TradeDirection;
  tradeSizeA: bigint;
  tradeSizeB: bigint;
  priceImpactPct: number,
  timings: Timings;
};

function unpackTokenAccount(
  pubkey: PublicKey,
  accountInfo: SimulatedTransactionAccountInfo,
): Token.Account {
  const data = Buffer.from(accountInfo.data[0], 'base64');
  const tokenAccountInfo = Token.unpackAccount(pubkey, {
    data,
    executable: accountInfo.executable,
    lamports: accountInfo.lamports,
    owner: new PublicKey(accountInfo.owner),
    rentEpoch: accountInfo.rentEpoch,
  });
  return tokenAccountInfo;
}

const recentTransactions = new Set<string>();

setInterval(() => {
  recentTransactions.clear();
}, 1000 * 1).unref();

async function* postSimulateFilter(
  simulationsIterator: AsyncGenerator<SimulationResult>,
): AsyncGenerator<BackrunnableTrade> {
  const simulationsIteratorGreedy = dropBeyondHighWaterMark(
    simulationsIterator,
    HIGH_WATER_MARK,
    'simulationsIterator',
  );

  for await (const {
    txn,
    response,
    accountsOfInterest,
    timings,
  } of simulationsIteratorGreedy) {
    logger.trace({ response }, "response")

    if (response.value.transactionResults.length === 0) {
      continue;
    }

    const txnSimulationResult = response.value.transactionResults[0];

    if (txnSimulationResult.err !== null) {
      continue;
    }

    const markets = new Set<Market>();
    const preSimTokenAccounts = new Map<string, Token.Account>();
    const postSimTokenAccounts = new Map<string, Token.Account>();

    for (let i = 0; i < accountsOfInterest.length; i++) {
      if (
        !txnSimulationResult.preExecutionAccounts?.[i] ||
        !txnSimulationResult.postExecutionAccounts?.[i]
      ) {
        continue;
      }

      const accountOfInterest = accountsOfInterest[i];
      const preSimState = txnSimulationResult.preExecutionAccounts[i];
      const postSimState = txnSimulationResult.postExecutionAccounts[i];

      const preSimTokenAccount = unpackTokenAccount(
        new PublicKey(accountOfInterest),
        preSimState,
      );
      const postSimTokenAccount = unpackTokenAccount(
        new PublicKey(accountOfInterest),
        postSimState,
      );

      preSimTokenAccounts.set(accountOfInterest, preSimTokenAccount);
      postSimTokenAccounts.set(accountOfInterest, postSimTokenAccount);

      const market = getMarketForVault(accountOfInterest);
      if (market) markets.add(market);
    }

    for (const market of markets) {
      const preSimTokenAccountVaultA = preSimTokenAccounts.get(
        market.tokenVaultA,
      );
      const postSimTokenAccountVaultA = postSimTokenAccounts.get(
        market.tokenVaultA,
      );
      const preSimTokenAccountVaultB = preSimTokenAccounts.get(
        market.tokenVaultB,
      );
      const postSimTokenAccountVaultB = postSimTokenAccounts.get(
        market.tokenVaultB,
      );

      const tokenAIsBase =
        market.tokenMintA === BASE_MINTS_OF_INTEREST_B58.SOL ||
        market.tokenMintA === BASE_MINTS_OF_INTEREST_B58.USDC;

      if (
        !preSimTokenAccountVaultA ||
        !postSimTokenAccountVaultA ||
        !preSimTokenAccountVaultB ||
        !postSimTokenAccountVaultB
      ) {
        continue;
      }

      const tokenADiff =
        postSimTokenAccountVaultA.amount - preSimTokenAccountVaultA.amount;
      const tokenAIsNegative = tokenADiff < 0n;
      const tokenADiffAbs = tokenAIsNegative ? -tokenADiff : tokenADiff;

      const tokenBDiff =
        postSimTokenAccountVaultB.amount - preSimTokenAccountVaultB.amount;
      const tokenBIsNegative = tokenBDiff < 0n;
      const tokenBDiffAbs = tokenBIsNegative ? -tokenBDiff : tokenBDiff;

      const didNotChangeVaults = tokenADiffAbs === 0n || tokenBDiffAbs === 0n;
      const addOrRemoveLiq = tokenAIsNegative === tokenBIsNegative;
      if (didNotChangeVaults || addOrRemoveLiq) {
        continue;
      }

      const duplicateTransactionString = txn.message.staticAccountKeys[0].toBase58() + market.id + tokenADiff.toString() + tokenBDiff.toString();

      if (recentTransactions.has(duplicateTransactionString)) {
        logger.trace('dropped duplicate: ' + duplicateTransactionString)
        continue
      }

      recentTransactions.add(duplicateTransactionString);

      const priceBefore = Number(preSimTokenAccountVaultB.amount * 1000000000n / preSimTokenAccountVaultA.amount) / 1000000000;
      const priceAfter = Number(postSimTokenAccountVaultB.amount * 1000000000n / postSimTokenAccountVaultA.amount) / 1000000000;
      const priceImpactPct = Math.abs((priceAfter - priceBefore)) / priceBefore * 100;

      if (isNaN(priceImpactPct) || priceImpactPct < MIN_PRICE_IMPACT_PCT_FILTER) continue;

      logger.debug(
        `${market.dexLabel} ${bs58.encode(txn.signatures[0])} \n${market.tokenMintA
        } ${postSimTokenAccountVaultA.amount} - ${preSimTokenAccountVaultA.amount
        } = ${tokenADiff} \n${market.tokenMintB} ${postSimTokenAccountVaultB.amount
        } - ${preSimTokenAccountVaultB.amount} = ${tokenBDiff}`,
      );

      const isBaseNegative = tokenAIsBase ? tokenAIsNegative : tokenBIsNegative;

      yield {
        txn,
        market,
        baseIsTokenA: tokenAIsBase,
        tradeDirection: isBaseNegative
          ? TradeDirection.BOUGHT_BASE
          : TradeDirection.SOLD_BASE,
        tradeSizeA: tokenADiffAbs,
        tradeSizeB: tokenBDiffAbs,
        priceImpactPct,
        timings: {
          mempoolEnd: timings.mempoolEnd,
          preSimEnd: timings.preSimEnd,
          simEnd: timings.simEnd,
          postSimEnd: Date.now(),
          calcArbEnd: 0,
          buildBundleEnd: 0,
          bundleSent: 0,
        },
      };
    }
  }
}

const ARB_HIGH_WATER_MARK = 100;

const JSBI = defaultImport(jsbi);

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


const ARB_CALCULATION_NUM_STEPS = JSBI.BigInt(config.get('arb_calculation_num_steps'));
const ZERO = JSBI.BigInt(0);
const TWO = JSBI.BigInt(2);
const SCALING_FACTOR = JSBI.BigInt(10000);
const BPS_MULTIPLIER = JSBI.BigInt(10000);

const MAX_USDC_BALANCE = 1200 * 10 ** 6
const MAX_SOL_BALANCE = 12 * 10 ** 9

function calculateSteppedInputs(inputBase: JsbiType, steps: JsbiType): JsbiType[] {
  const stepSize = JSBI.divide(inputBase, steps)
  return new Array(steps).map((_, i) => JSBI.add(inputBase, JSBI.multiply(stepSize, JSBI.BigInt(i))));
}

function calculatedFixedLegQuotes(inputSteps: JsbiType[], balancingLeg: SerializableLegFixed): Omit<Quote, 'quote' | 'tipBps'>[] {
  return inputSteps
    .map(i => calculateFixedLegQuote(i, balancingLeg.marketId, JSBI.BigInt(balancingLeg.in), JSBI.BigInt(balancingLeg.estimatedOutExcludingFees)))
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
    logger.debug('Failed to fetch Jupiter quote, try manually: ' + url)

    return {
      in: ZERO, out: ZERO
    }
  }
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


async function calculateJupiterBestQuote(
  { balancingLeg, mirroringLeg, balancingLegFirst, victimTxnSignature }:
    {
      balancingLeg: SerializableLegFixed,
      mirroringLeg: SerializableLeg,
      balancingLegFirst: boolean,
      victimTxnSignature: string
    }
): Promise<BestQuote> {
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
    return null
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
    quote: bestQuote,
    profit: profit.toString()
  }
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
    ARB_HIGH_WATER_MARK,
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
      {
        balancingLeg,
        mirroringLeg,
        balancingLegFirst,
        victimTxnSignature: bs58.encode(txn.signatures[0])
      });

    if (bestQuoteResult === null) continue;

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


const TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
].map((pubkey) => new PublicKey(pubkey));

const getRandomTipAccount = () =>
  TIP_ACCOUNTS[Math.floor(Math.random() * TIP_ACCOUNTS.length)];

const MIN_TIP_LAMPORTS = config.get('min_tip_lamports');
const MAX_TIP_BPS = config.get('max_tip_bps');
const LEDGER_PROGRAM_ID = config.get('ledger_program')
const TXN_FEES_LAMPORTS = config.get('txn_fees_lamports'); // transaction fees in lamports TODO: need to consider new token account rents?

// const MIN_BALANCE_RENT_EXEMPT_TOKEN_ACC =
//   await getMinimumBalanceForRentExemptAccount(connection);

// TODO: default minimum profit needs to cover transaction fee and the rent of tokens (regardless if there is a new one)
const MIN_PROFIT_IN_LAMPORTS = TXN_FEES_LAMPORTS // + MIN_BALANCE_RENT_EXEMPT_TOKEN_ACC; // in lamports

const payer = Keypair.fromSecretKey(
  Uint8Array.from(
    JSON.parse(fs.readFileSync(config.get('payer_keypair_path'), 'utf-8')),
  ),
);

const wallet = new anchor.Wallet(payer);
const provider = new anchor.AnchorProvider(connection, wallet, {
  commitment: "confirmed",
});
const ledgerProgram = new Program(JitoBomb, LEDGER_PROGRAM_ID, provider)

// todo: need to dynamically update this
const LAMPORTS_PER_USDC_UNITS = LAMPORTS_PER_USDC_UNIT

function deserializeSwapInstruction(instruction: Instruction) {
  return new TransactionInstruction({
    programId: new PublicKey(instruction.programId),
    keys: instruction.accounts.map((key) => ({
      pubkey: new PublicKey(key.pubkey),
      isSigner: key.isSigner,
      isWritable: key.isWritable,
    })), data: Buffer.from(instruction.data, "base64"),
  });
}

const addressLookupTableAccountCache = new Map<string, AddressLookupTableAccount>();

async function getAddressLookupTableAccounts(
  keys: string[]
): Promise<AddressLookupTableAccount[]> {
  const newKeys: string[] = [];
  const cachedResults: AddressLookupTableAccount[] = [];

  // Separate new keys and cached keys
  keys.forEach(key => {
    if (addressLookupTableAccountCache.has(key)) {
      cachedResults.push(addressLookupTableAccountCache.get(key));
    } else {
      newKeys.push(key);
    }
  });

  // Fetch new keys only
  const addressLookupTableAccountInfos = await connection.getMultipleAccountsInfo(
    newKeys.map(key => new PublicKey(key))
  );

  const newResults = addressLookupTableAccountInfos.reduce((acc, accountInfo, index) => {
    const addressLookupTableAddress = newKeys[index];
    if (accountInfo) {
      const addressLookupTableAccount = new AddressLookupTableAccount({
        key: new PublicKey(addressLookupTableAddress),
        state: AddressLookupTableAccount.deserialize(accountInfo.data),
      });
      acc.push(addressLookupTableAccount);
      addressLookupTableAccountCache.set(addressLookupTableAddress, addressLookupTableAccount);
    }

    return acc;
  }, [] as AddressLookupTableAccount[]);

  // Combine cached results and new results
  return [...cachedResults, ...newResults];
}

export type Arb = {
  bundle: VersionedTransaction[];
  expectedProfit: JsbiType;
  trade: ArbIdeaTrade
  timings: Timings;
};

const ataCache = new Map<string, PublicKey>();
const getAta = (mint: PublicKey, owner: PublicKey) => {
  const key = `${mint.toBase58()}-${owner.toBase58()}`;
  if (ataCache.has(key)) {
    return ataCache.get(key);
  }
  const ata = getAssociatedTokenAddressSync(mint, owner);
  ataCache.set(key, ata);
  return ata;
};

const wrappedSolAccount = getAta(NATIVE_MINT, wallet.publicKey)

// create wrapped sol account
const createWrappedSolAccountIx =
  createAssociatedTokenAccountIdempotentInstruction(
    wallet.publicKey,
    wrappedSolAccount,
    wallet.publicKey,
    NATIVE_MINT
  )

// close wrapped sol account
const closeWrappedSolAccountIx = createCloseAccountInstruction(
  wrappedSolAccount,
  wallet.publicKey,
  wallet.publicKey
);

const syncNativeIx = createSyncNativeInstruction(
  wrappedSolAccount
)

async function* buildBundle(
  arbIdeaIterator: AsyncGenerator<ArbIdea>,
): AsyncGenerator<Arb> {
  for await (const arbIdea of arbIdeaIterator) {
    const { txn, expectedProfit, timings, trade, } = arbIdea;
    const { in: inAmount, out: outAmount, mirroringLegQuote, balancingLeg, balancingLegFirst, tipBps } = trade;

    const allRoutesQuoteResponse = createAllRoutesQuoteResponse(
      {
        mirroringLegQuote,
        inAmount: inAmount,
        outAmount: outAmount,
        balancingLeg,
        balancingLegFirst
      }
    )

    logger.debug({ allRoutesQuoteResponse }, "all routes quote")

    let backrunningTx: VersionedTransaction
    try {
      backrunningTx = await compileJupiterTransaction(
        {
          quoteResponse: allRoutesQuoteResponse,
          inAmount: inAmount,
          balancingLeg,
          balancingLegFirst,
          tipBps,
          wallet,
          blockhash: txn.message.recentBlockhash,
        }
      )
    } catch (e) {
      logger.debug({ e }, "error compileJupiterTransaction")
    }

    if (!backrunningTx) {
      continue
    }

    const res = await connection.simulateTransaction(backrunningTx, {
      replaceRecentBlockhash: false,
      commitment: "confirmed",
    })

    logger.info({ res }, "simulateTransaction")

    // construct bundle
    const bundle = [txn, backrunningTx];

    yield {
      bundle,
      expectedProfit,
      trade,
      timings: {
        mempoolEnd: timings.mempoolEnd,
        preSimEnd: timings.preSimEnd,
        simEnd: timings.simEnd,
        postSimEnd: timings.postSimEnd,
        calcArbEnd: timings.calcArbEnd,
        buildBundleEnd: Date.now(),
        bundleSent: 0,
      },
    };
  }
}

function createAllRoutesQuoteResponse(
  {
    mirroringLegQuote,
    inAmount,
    outAmount,
    balancingLeg,
    balancingLegFirst
  }:
    {
      mirroringLegQuote: QuoteResponse,
      inAmount: JsbiType,
      outAmount: JsbiType,
      balancingLeg: SerializableLegFixed,
      balancingLegFirst: boolean
    }
): QuoteResponse {
  const mirroringLegRoutePlan = mirroringLegQuote.routePlan

  const allRoutesPlan: RoutePlanStep[] = [];
  const inputMint = balancingLegFirst ? balancingLeg.sourceMint : balancingLeg.destinationMint;
  const outputMint = balancingLegFirst ? balancingLeg.sourceMint : balancingLeg.destinationMint;

  const balancingLegRoutePlan: RoutePlanStep = {
    swapInfo: {
      ammKey: balancingLeg.marketId,
      label: balancingLeg.dex,
      inputMint: balancingLeg.sourceMint,
      outputMint: balancingLeg.destinationMint,
      inAmount: inAmount.toString(),
      outAmount: outAmount.toString(),
      feeAmount: "0",
      feeMint: inputMint,
    },
    percent: 100
  };

  if (balancingLegFirst) {
    allRoutesPlan.push(balancingLegRoutePlan, ...mirroringLegRoutePlan);
  } else {
    allRoutesPlan.push(...mirroringLegRoutePlan, balancingLegRoutePlan);
  }

  // construct quote response
  return {
    inputMint: inputMint,
    outputMint: outputMint,
    inAmount: inAmount.toString(),
    outAmount: inAmount.toString(),
    otherAmountThreshold: inAmount.toString(),
    swapMode: SwapMode.ExactIn,
    slippageBps: 2000, // we have ledger to check at the end so this is ok
    priceImpactPct: "1",
    routePlan: allRoutesPlan,
  };
}

async function compileJupiterTransaction(
  {
    quoteResponse,
    inAmount,
    balancingLeg,
    balancingLegFirst,
    tipBps,
    wallet,
    blockhash
  }:
    {
      quoteResponse: QuoteResponse,
      inAmount: JsbiType,
      balancingLeg: SerializableLegFixed,
      balancingLegFirst: boolean,
      tipBps: number,
      wallet: anchor.Wallet,
      blockhash: string,
    }
) {
  let allSwapInstructionsResponse: SwapInstructionsResponse
  try {
    allSwapInstructionsResponse = await jupiterClient.swapInstructionsPost({
      swapRequest: {
        userPublicKey: wallet.publicKey.toBase58(),
        quoteResponse: quoteResponse,
        useSharedAccounts: false,
        wrapAndUnwrapSol: false
      }
    })

  } catch (e) {
    logger.debug(e, "error jupiter swapInstructionsPost")
  }

  if (!allSwapInstructionsResponse) {
    throw new Error("no swap instructions response")
  }

  const inputMint = balancingLegFirst ? balancingLeg.sourceMint : balancingLeg.destinationMint;

  const randomSeed = new BN(Math.floor(Math.random() * 1000000));

  // todo: to optimize this
  const ledgerAccount = PublicKey.findProgramAddressSync(
    [Buffer.from("ledger"), wallet.publicKey.toBuffer(), randomSeed.toArrayLike(Buffer, "le", 8)],
    ledgerProgram.programId
  )[0];

  const baseTokenATA = getAta(
    new PublicKey(inputMint),
    wallet.publicKey
  );

  const minimumProfitInBaseToken = inputMint === BASE_MINTS_OF_INTEREST_B58.SOL ? MIN_PROFIT_IN_LAMPORTS : Math.ceil(MIN_PROFIT_IN_LAMPORTS / LAMPORTS_PER_USDC_UNITS)
  const lamportsPerBaseToken = inputMint === BASE_MINTS_OF_INTEREST_B58.SOL ? 1 : LAMPORTS_PER_USDC_UNITS

  // manual construct instruction
  const instructions: TransactionInstruction[] = []

  // increse compute unit
  const modifyComputeUnitsIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: 1000000
  });

  instructions.push(modifyComputeUnitsIx)

  if (inputMint === BASE_MINTS_OF_INTEREST_B58.SOL) {
    const wrappedSolAccount = getAta(NATIVE_MINT, wallet.publicKey)

    // transfer sol
    const transferIx = SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: wrappedSolAccount,
      lamports: JSBI.toNumber(inAmount)
    });

    instructions.push(createWrappedSolAccountIx)
    instructions.push(transferIx)
    instructions.push(syncNativeIx)
  }

  const startLedgerIx = await ledgerProgram.methods
    .startLedger(randomSeed)
    .accountsStrict({
      signer: wallet.publicKey,
      monitorAta: baseTokenATA,
      ledgerAccount,
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  instructions.push(startLedgerIx)

  if (allSwapInstructionsResponse.tokenLedgerInstruction) {
    instructions.push(deserializeSwapInstruction(allSwapInstructionsResponse.tokenLedgerInstruction))
  }

  instructions.push(deserializeSwapInstruction(allSwapInstructionsResponse.swapInstruction))

  // if sol is base, sync native
  if (inputMint === BASE_MINTS_OF_INTEREST_B58.SOL) {
    instructions.push(syncNativeIx)
  }

  const endLedgerIx = await ledgerProgram.methods
    .endLedger(
      randomSeed,
      new BN(minimumProfitInBaseToken), // minimum profit in base token
      lamportsPerBaseToken,
      new BN(tipBps), // tip bps of the (profit minus minimum profit in base token) TODO: dynamic tip in custom program
      new BN(MAX_TIP_BPS), // max tip bps of the sol balance
      new BN(MIN_TIP_LAMPORTS), // requires tip > min tip amount
    )
    .accountsStrict({
      signer: wallet.publicKey,
      monitorAta: baseTokenATA,
      ledgerAccount,
      tipAccount: getRandomTipAccount(),
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  instructions.push(endLedgerIx)

  if (inputMint === BASE_MINTS_OF_INTEREST_B58.SOL) {
    instructions.push(closeWrappedSolAccountIx)
  }

  const addressLookupTableAccounts = await getAddressLookupTableAccounts(allSwapInstructionsResponse.addressLookupTableAddresses)

  const messageV0 = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions: instructions,
  }).compileToV0Message(addressLookupTableAccounts);

  const backrunningTx = new VersionedTransaction(messageV0);

  // sign and send
  backrunningTx.sign([wallet.payer]);

  return backrunningTx
}

async function runBot(mempoolUpdate: MempoolUpdate) {
  // filter for transactions that have the correct market token accounts
  const filteredTransactions = preSimulationFilter(mempoolUpdate);

  // simulate those transactions
  const simulations = simulate(filteredTransactions);

  // find transactions that are 'trades in pools'
  const backrunnableTrades = postSimulateFilter(simulations);

  //find potential arb opportunities
  const arbIdeas = calculateArb(backrunnableTrades);

  // build the bundle to submit
  const bundles = buildBundle(arbIdeas);

  for await(const bundle of bundles) {
    logger.debug(`bundle: ${bundle}`);
  }

  parentPort!.postMessage(null)
}

parentPort.on('message', (message: BotWorkerParamMessage) => {
  switch (message.type) {
    case 'runBot': {
      try {
        runBot(message.payload as MempoolUpdate);
      } catch (e) {
        logger.error({ e }, 'runBot error');
      }
      break;
    }
  }
});
