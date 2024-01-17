import {
  Quote as JupiterQuote,
  QuoteParams,
} from '@jup-ag/core/dist/lib/amm.js';
import { defaultImport } from 'default-import';
import jsbi from 'jsbi';
import { config } from '../config.js';
import { BASE_MINTS_OF_INTEREST_B58 } from '../constants.js';
import { logger } from '../logger.js';
import { WorkerPool } from '../worker-pool.js';
import { MintMarketGraph } from './market-graph.js';
import { OrcaWhirpoolDEX } from './orca-whirlpool/index.js';
import { RaydiumClmmDEX } from './raydium-clmm/index.js';
import { RaydiumDEX } from './raydium/index.js';
import { SplTokenSwapDEX } from './spl-token-swap/index.js';
import {
  AddPoolResultPayload,
  AmmCalcWorkerParamMessage,
  AmmCalcWorkerResultMessage,
  CalculateQuoteResultPayload,
  CalculateRouteResultPayload,
  DEX,
  Market,
  Quote,
  SerializableRoute,
} from './types.js';
import { toJupiterQuote, toSerializableQuoteParams } from './utils.js';

const JSBI = defaultImport(jsbi);

const NUM_WORKER_THREADS = config.get('num_worker_threads');

const ammCalcWorkerPool = new WorkerPool(
  NUM_WORKER_THREADS,
  './build/src/markets/amm-calc-worker.js',
);
await ammCalcWorkerPool.initialize();
logger.info('Initialized AMM calc worker pool');

const dexs: DEX[] = [
  new SplTokenSwapDEX(),
  new OrcaWhirpoolDEX(),
  new RaydiumDEX(),
  new RaydiumClmmDEX(),
];

for (const dex of dexs) {
  for (const addPoolMessage of dex.getAmmCalcAddPoolMessages()) {
    const results = ammCalcWorkerPool.runTaskOnAllWorkers<
      AmmCalcWorkerParamMessage,
      AmmCalcWorkerResultMessage
    >(addPoolMessage);
    Promise.race(results).then((result) => {
      if (result.type !== 'addPool') {
        throw new Error('Unexpected result type in addPool response');
      }
      const payload = result.payload as AddPoolResultPayload;
      return payload.accountsForUpdate;
    });
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
const tokensOfInterest = new Set(
  Array.from(tokensOfInterestMap.keys()).filter(
    (key) => tokensOfInterestMap.get(key) > 1,
  ),
);

logger.debug('Number of tokens of interest: ' + tokensOfInterest.size);

for (const dex of dexs) {
  for (const market of dex.getAllMarkets()) {
    const isMarketOfInterest =
      market.tokenMintA == BASE_MINTS_OF_INTEREST_B58.USDC ||
      market.tokenMintA == BASE_MINTS_OF_INTEREST_B58.SOL ||
      market.tokenMintB == BASE_MINTS_OF_INTEREST_B58.USDC ||
      market.tokenMintB == BASE_MINTS_OF_INTEREST_B58.SOL;

    // filter tokens of interest
    const isTokenOfInterest =
      tokensOfInterest.has(market.tokenMintA) ||
      tokensOfInterest.has(market.tokenMintB);

    if (isMarketOfInterest && isTokenOfInterest) {
      tokenAccountsOfInterest.set(market.tokenVaultA, market);
      tokenAccountsOfInterest.set(market.tokenVaultB, market);

      marketGraph.addMarket(market.tokenMintA, market.tokenMintB, market);
    }
  }
}

const isTokenAccountOfInterest = (tokenAccount: string): boolean => {
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

const getMarketsForPair = (mintA: string, mintB: string): Market[] => {
  const markets: Market[] = [];
  for (const dex of dexs) {
    markets.push(...dex.getMarketsForPair(mintA, mintB));
  }
  return markets;
};

type Route = {
  hop1: Market;
  hop2: Market;
};

const routeCache: Map<string, Route[]> = new Map();

function getAll2HopRoutes(
  sourceMint: string,
  destinationMint: string,
): Route[] {
  const cacheKey = `${sourceMint}-${destinationMint}`;
  const cacheKeyReverse = `${destinationMint}-${sourceMint}`;

  if (routeCache.has(cacheKey)) {
    logger.debug(`Cache hit for ${cacheKey}`);
    return routeCache.get(cacheKey)!;
  }
  const sourceNeighbours = marketGraph.getNeighbours(sourceMint);
  const destNeighbours = marketGraph.getNeighbours(destinationMint);
  let intersections: Set<string> = new Set();
  if (sourceNeighbours.size < destNeighbours.size) {
    intersections = new Set(
      [...sourceNeighbours].filter((i) => destNeighbours.has(i)),
    );
  } else {
    intersections = new Set(
      [...destNeighbours].filter((i) => sourceNeighbours.has(i)),
    );
  }

  const routes: {
    hop1: Market;
    hop2: Market;
  }[] = [];
  const routesReverse: {
    hop1: Market;
    hop2: Market;
  }[] = [];

  for (const intersection of intersections) {
    const hop1 = marketGraph.getMarkets(sourceMint, intersection);
    const hop2 = marketGraph.getMarkets(intersection, destinationMint);
    for (const hop1Market of hop1) {
      for (const hop2Market of hop2) {
        routes.push({
          hop1: hop1Market,
          hop2: hop2Market,
        });
        routesReverse.push({
          hop1: hop2Market,
          hop2: hop1Market,
        });
      }
    }
  }
  routeCache.set(cacheKey, routes);
  routeCache.set(cacheKeyReverse, routesReverse);
  return routes;
}

async function calculateQuote(
  poolId: string,
  params: QuoteParams,
  timeout?: number,
  prioritze?: boolean,
): Promise<JupiterQuote | null> {
  logger.debug(`Calculating quote for ${poolId} ${JSON.stringify(params)}`);
  const serializableQuoteParams = toSerializableQuoteParams(params);
  const message: AmmCalcWorkerParamMessage = {
    type: 'calculateQuote',
    payload: {
      id: poolId,
      params: serializableQuoteParams,
    },
  };

  const result = await ammCalcWorkerPool.runTask<
    AmmCalcWorkerParamMessage,
    AmmCalcWorkerResultMessage
  >(message, timeout, prioritze);
  if (result === null) return null;
  const payload = result.payload as CalculateQuoteResultPayload;
  if (payload.error !== undefined) throw payload.error;

  const serializableQuote = payload.quote;
  const quote = toJupiterQuote(serializableQuote);
  return quote;
}

async function calculateRoute(
  route: SerializableRoute,
  timeout?: number,
): Promise<Quote | null> {
  const message: AmmCalcWorkerParamMessage = {
    type: 'calculateRoute',
    payload: { route },
  };
  const result = await ammCalcWorkerPool.runTask<
    AmmCalcWorkerParamMessage,
    AmmCalcWorkerResultMessage
  >(message, timeout);

  if (result === null) return null;

  const payload = result.payload as CalculateRouteResultPayload;
  const serializableQuote = payload.quote;

  return {
    in: JSBI.BigInt(serializableQuote.in),
    out: JSBI.BigInt(serializableQuote.out),
  };
}

export {
  DEX,
  calculateQuote,
  calculateRoute,
  getAll2HopRoutes,
  getMarketForVault,
  getMarketsForPair,
  isTokenAccountOfInterest,
};
