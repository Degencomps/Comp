import { defaultImport } from 'default-import';
import jsbi from 'jsbi';

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