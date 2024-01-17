// import { buildBundle } from './build-bundle.js';
// import { calculateArb } from './calculate-arb.js';
import { mempool } from './mempool.js';
// import { postSimulateFilter } from './post-simulation-filter.js';
import { preSimulationFilter } from './pre-simulation-filter.js';
import { simulate } from './simulation.js';
// import { sendBundle } from './send-bundle.js';

// find transactions in the right programs
const mempoolUpdates = mempool();

// filter for transactions that have the correct market token accounts
const filteredTransactions = preSimulationFilter(mempoolUpdates);

// simulate those transactions
const simulations = simulate(filteredTransactions);

for await (const simulation of simulations) {
  console.log(simulation);
}

// find transactions that are 'trades in pools'
// const backrunnableTrades = postSimulateFilter(simulations);

// find potential arb opportunities
// const arbIdeas = calculateArb(backrunnableTrades);

// build the bundle to submit
// buildBundle(arbIdeas);
//const bundles = buildBundle(arbIdeas);

// submit bundles
//await sendBundle(bundles);
