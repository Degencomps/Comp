import { buildBundle } from './build-bundle.js';
import { calculateArb } from './calculate-arb.js';
import { mempool } from './mempool.js';
import { postSimulateFilter } from './post-simulation-filter.js';
import { preSimulationFilter } from './pre-simulation-filter.js';
import { simulate } from './simulation.js';
//import { sendBundle } from './send-bundle.js';

// these are async generators, so essentially streams, but typed
const mempoolUpdates = mempool();
const filteredTransactions = preSimulationFilter(mempoolUpdates);
const simulations = simulate(filteredTransactions);
const backrunnableTrades = postSimulateFilter(simulations);
const arbIdeas = calculateArb(backrunnableTrades);
buildBundle(arbIdeas);
//const bundles = buildBundle(arbIdeas);
//await sendBundle(bundles);
