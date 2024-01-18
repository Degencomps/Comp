import {
  AddressLookupTableAccount,
  MessageAccountKeys,
  VersionedTransaction,
} from '@solana/web3.js';
import { logger } from './logger.js';
import { lookupTableProvider } from './lookup-table-provider.js';
import { isTokenAccountOfInterest } from './markets/index.js';
import { MempoolUpdate } from './mempool.js';
import { Timings } from './types.js';
import { clearOnHighWaterMark } from './utils.js';

const SKIP_TX_IF_CONTAINS_ADDRESS = [
  '882DFRCi5akKFyYxT4PP2vZkoQEGvm2Nsind2nPDuGqu', // orca whirlpool mm whose rebalancing txns mess with the calc down the line and is no point in backrunning
];

const HIGH_WATER_MARK = 250;
const MAX_MEMPOOL_AGE_MS = 50;

type FilteredTransaction = {
  txn: VersionedTransaction;
  accountsOfInterest: string[];
  timings: Timings;
};

async function* preSimulationFilter(
  mempoolUpdates: AsyncGenerator<MempoolUpdate>,
): AsyncGenerator<FilteredTransaction> {
  // this makes sure we never have more than HIGH_WATER_MARK transactions pending
  const mempoolUpdatesGreedy = clearOnHighWaterMark(
    mempoolUpdates,
    HIGH_WATER_MARK,
    'mempoolUpdates',
  );

  for await (const { txns, timings } of mempoolUpdatesGreedy) {
    const age = Date.now() - timings.mempoolEnd;
    if (age > MAX_MEMPOOL_AGE_MS) {
      logger.debug(`Skipping mempool entry - age: ${age}ms`);
      continue;
    }

    for (const txn of txns) {
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
        logger.warn(e, 'address not in lookup table, refreshing');
        for (const lookup of txn.message.addressTableLookups) {
          await lookupTableProvider.getLookupTable(lookup.accountKey, true);
        }
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

      if (skipTx) continue;
      if (accountsOfInterest.size === 0) continue;

      logger.trace(
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
  }
}

export { FilteredTransaction, preSimulationFilter };
