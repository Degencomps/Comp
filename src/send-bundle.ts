import bs58 from 'bs58';
import { stringify } from 'csv-stringify';
import * as fs from 'fs';
import { Bundle as JitoBundle } from 'jito-ts/dist/sdk/block-engine/types.js';
import { Arb } from './build-bundle.js';
import { searcherClientManager } from './clients/jito.js';
import { connection } from './clients/rpc.js';
import { logger } from './logger.js';
import { MAX_TRADE_AGE_MS } from "./calculate-arb.js";
import { getFormattedTimestamp } from "./utils.js";

const CHECK_LANDED_DELAY_MS = 30000;

type Trade = {
  accepted: number;
  rejected: boolean;
  errorType: string | null;
  errorContent: string | null;
  landed: boolean;
} & Arb;

type TradeCSV = {
  timestamp: number;
  uuid: string;
  landed: boolean;
  accepted: number;
  rejected: boolean;
  errorType: string | null;
  errorContent: string | null;
  txn0Signature: string;
  txn1Signature: string;
  trade: string;
  expectedProfit: string;
  tipBps: string;
  mempoolEnd: number;
  preSimEnd: number;
  simEnd: number;
  postSimEnd: number;
  calcArbEnd: number;
  buildBundleEnd: number;
  bundleSent: number;
};

const tradesCsv = fs.createWriteStream(`trades_${getFormattedTimestamp()}.csv`, { flags: 'a' });
const stringifier = stringify({
  header: true,
});
stringifier.pipe(tradesCsv);

const bundlesInTransit = new Map<string, Trade>();

async function processCompletedTrade(uuid: string) {
  const trade = bundlesInTransit.get(uuid)!;

  const txn0Signature = bs58.encode(trade.bundle[0].signatures[0]);
  const txn1Signature = bs58.encode(trade.bundle[1].signatures[0]);

  const txn1 = await connection
    .getTransaction(txn1Signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 10,
    })
    .catch(() => {
      logger.info(
        `getTransaction failed. Backrunning ${txn0Signature}; Assuming txn1 ${txn1Signature} did not land`,
      );
      return null;
    });

  if (txn1 !== null) {
    logger.info(`**** Money money: Backrunning ${txn0Signature} with Tx ${txn1Signature} landed`);
    trade.landed = true;
  }

  const tradeCsv: TradeCSV = {
    timestamp: Date.now(),
    uuid,
    landed: trade.landed,
    accepted: trade.accepted,
    rejected: trade.rejected,
    errorType: trade.errorType,
    errorContent: trade.errorContent,
    txn0Signature,
    txn1Signature,
    trade: JSON.stringify(trade.trade),
    expectedProfit: trade.expectedProfit.toString(),
    tipBps: trade.trade.tipBps.toString(),
    mempoolEnd: trade.timings.mempoolEnd,
    preSimEnd: trade.timings.preSimEnd,
    simEnd: trade.timings.simEnd,
    postSimEnd: trade.timings.postSimEnd,
    calcArbEnd: trade.timings.calcArbEnd,
    buildBundleEnd: trade.timings.buildBundleEnd,
    bundleSent: trade.timings.bundleSent,
  };
  stringifier.write(tradeCsv);
  bundlesInTransit.delete(uuid);
  return;
}

async function sendBundle(bundleIterator: AsyncGenerator<Arb>): Promise<void> {
  for await (const {
    bundle,
    expectedProfit,
    trade,
    timings,
  } of bundleIterator) {
    const now = Date.now();
    if (now - timings.mempoolEnd > MAX_TRADE_AGE_MS) {
      logger.debug(`Trade is too old, skipping send bundle`);
      continue;
    }

    const searcherSendClient = searcherClientManager.getNextClient();

    searcherSendClient
      .sendBundle(new JitoBundle(bundle, 5))
      .then((bundleId) => {
        logger.info(
          `Bundle ${bundleId} sent, backrunning ${bs58.encode(
            bundle[0].signatures[0],
          )} with Tx ${bs58.encode(bundle[1].signatures[0])}`,
        );

        timings.bundleSent = now;
        logger.info(
          `chain timings: pre sim: ${timings.preSimEnd - timings.mempoolEnd
          }ms, sim: ${timings.simEnd - timings.preSimEnd}ms, post sim: ${timings.postSimEnd - timings.simEnd
          }ms, arb calc: ${timings.calcArbEnd - timings.postSimEnd
          }ms, build bundle: ${timings.buildBundleEnd - timings.calcArbEnd
          }ms send bundle: ${timings.bundleSent - timings.buildBundleEnd
          }ms ::: total ${now - timings.mempoolEnd}ms`,
        );

        bundlesInTransit.set(bundleId, {
          bundle,
          expectedProfit,
          accepted: 0,
          rejected: false,
          errorType: null,
          errorContent: null,
          landed: false,
          trade,
          timings,
        });
        setTimeout(() => {
          processCompletedTrade(bundleId);
        }, CHECK_LANDED_DELAY_MS);
      })
      .catch((error) => {
        timings.bundleSent = now;
        logger.debug(
          `chain timings: pre sim: ${timings.preSimEnd - timings.mempoolEnd
          }ms, sim: ${timings.simEnd - timings.preSimEnd}ms, post sim: ${timings.postSimEnd - timings.simEnd
          }ms, arb calc: ${timings.calcArbEnd - timings.postSimEnd
          }ms, build bundle: ${timings.buildBundleEnd - timings.calcArbEnd
          }ms send bundle: ${timings.bundleSent - timings.buildBundleEnd
          }ms ::: total ${now - timings.mempoolEnd}ms`,
        );

        if (
          error?.message?.includes(
            'Bundle Dropped, no connected leader up soon',
          )
        ) {
          logger.error(
            'Error sending bundle: Bundle Dropped, no connected leader up soon.',
          );
        } else if (error?.message?.includes('RESOURCE_EXHAUSTED')) {
          logger.error('Error sending bundle: Rate limited');
        } else if (error?.message) {
          logger.warn('Error sending bundle: ' + error.message)
        } else {
          logger.error(error, 'Error sending bundle');
        }
        const txn0Signature = bs58.encode(bundle[0].signatures[0]);
        const txn1Signature = bs58.encode(bundle[1].signatures[0]);
        const tradeCsv: TradeCSV = {
          timestamp: Date.now(),
          uuid: '',
          landed: false,
          accepted: 0,
          rejected: true,
          errorType: 'sendingError',
          errorContent: JSON.stringify(error),
          txn0Signature,
          txn1Signature,
          trade: JSON.stringify(trade),
          expectedProfit: expectedProfit.toString(),
          tipBps: trade.tipBps.toString(),
          mempoolEnd: timings.mempoolEnd,
          preSimEnd: timings.preSimEnd,
          simEnd: timings.simEnd,
          postSimEnd: timings.postSimEnd,
          calcArbEnd: timings.calcArbEnd,
          buildBundleEnd: timings.buildBundleEnd,
          bundleSent: now,
        };
        stringifier.write(tradeCsv);
      });
  }
}

export { sendBundle };
