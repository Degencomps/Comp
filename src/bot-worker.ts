import { parentPort, workerData } from "worker_threads";
import { buildBundle } from "./build-bundle.js";
import { calculateArb } from "./calculate-arb.js";
import { postSimulateFilter } from "./post-simulation-filter.js";
import { preSimulationFilter } from "./pre-simulation-filter.js";
import { simulate } from "./simulation.js";
import { Timings } from "./types.js";
import { logger } from "./logger.js";
import { initialiseMarkets } from "./markets/index.js";
import { sendBundle } from "./send-bundle.js";

export type BotWorkerParamMessage = {
  type: 'mempool';
  payload: SerialisedMempoolUpdate
} | { type: 'initialize' }

export type SerialisedMempoolUpdate = {
  txnsSerialised: Uint8Array[];
  timings: Timings;
};

const workerId = workerData.workerId;

logger.info(`BotWorker ${workerId} started`);

const [mempoolUpdates, onMempoolUpdate] = createAsyncGeneratorCallback<SerialisedMempoolUpdate>()

parentPort.on('message', async (message: BotWorkerParamMessage) => {
  switch (message.type) {
    case 'mempool': {
      try {
        onMempoolUpdate(message.payload as SerialisedMempoolUpdate);
      } catch (e) {
        logger.error({ e }, 'transaction error');
      }
      parentPort!.postMessage("ok");
      break;
    }
    case 'initialize': {
      await initialiseMarkets();
      parentPort!.postMessage("ok");
    }
  }
});

// filter for transactions that have the correct market token accounts
const filteredTransactions = preSimulationFilter(mempoolUpdates);

// simulate those transactions
const simulations = simulate(filteredTransactions);

// find transactions that are 'trades in pools'
const backrunnableTrades = postSimulateFilter(simulations);

//find potential arb opportunities
const arbIdeas = calculateArb(backrunnableTrades);

// build the bundle to submit
const bundles = buildBundle(arbIdeas);

// send the bundle to the cluster
await sendBundle(bundles);

function createAsyncGeneratorCallback<T>(): [AsyncGenerator<T, any, undefined>, (value: T) => void] {
  let results: T[] = [];
  let resolve: ((value: T) => void) | null = null;
  let promise = new Promise(r => resolve = r);

  const generator = async function* (): AsyncGenerator<T, any, undefined> {

    while (true) {
      await promise;
      yield* results;
      results = [];
    }
  }();

  const callback = (value: T) => {
    results.push(value);
    resolve(value);
    promise = new Promise(r => resolve = r);
  };

  return [generator, callback];
}
