// import { buildBundle } from './build-bundle.js';
// import { calculateArb } from './calculate-arb.js';
import bs58 from "bs58";
import { logger } from "./logger.js";
import { mempool } from './mempool.js';
import { postSimulateFilter } from './post-simulation-filter.js';
import { preSimulationFilter } from './pre-simulation-filter.js';
import { simulate } from './simulation.js';
// import { sendBundle } from './send-bundle.js';

// find transactions in the right programs
const mempoolUpdates = mempool();

// filter for transactions that have the correct market token accounts
const filteredTransactions = preSimulationFilter(mempoolUpdates);

// simulate those transactions
const simulations = simulate(filteredTransactions);


// find transactions that are 'trades in pools'
const backrunnableTrades = postSimulateFilter(simulations);


for await (const backrunnableTrade of backrunnableTrades) {
  logger.info(`backrunnableTrade ${bs58.encode(backrunnableTrade.txn.signatures[0]).slice(0, 4)}... on ${backrunnableTrade.market.dexLabel} for ${backrunnableTrade.market.tokenMintA.slice(0, 4)}.../${backrunnableTrade.market.tokenMintB.slice(0, 4)}... ${backrunnableTrade.tradeSizeA}/${backrunnableTrade.tradeSizeB} by ${backrunnableTrade.txn.message.staticAccountKeys[0].toBase58()} with ${backrunnableTrade.priceImpactPct.toFixed(3)}% price impact`);
}

// find potential arb opportunities
// const arbIdeas = calculateArb(backrunnableTrades);

// build the bundle to submit
// buildBundle(arbIdeas);
//const bundles = buildBundle(arbIdeas);

// submit bundles
//await sendBundle(bundles);
