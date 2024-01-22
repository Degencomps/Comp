import { defaultImport } from 'default-import';
import jsbi from 'jsbi';
import { VersionedTransaction } from "@solana/web3.js";

export const JSBI = defaultImport(jsbi);

export type Timings = {
  mempoolEnd: number;
  preSimEnd: number;
  simEnd: number;
  postSimEnd: number;
  calcArbEnd: number;
  buildBundleEnd: number;
  bundleSent: number;
};

const BIGINT_TYPE = JSBI.BigInt(0);
export type JsbiType = typeof BIGINT_TYPE;


export type BotWorkerParamMessage = {
  type: 'runBot';
  payload: MempoolUpdate
}

export type MempoolUpdate = {
  txn: Uint8Array;
  timings: Timings;
};

export type FilteredTransaction = {
  txn: VersionedTransaction;
  accountsOfInterest: string[];
  timings: Timings;
};
