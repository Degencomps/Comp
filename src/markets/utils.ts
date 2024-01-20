import { AccountInfo, PublicKey } from '@solana/web3.js';
import { defaultImport } from 'default-import';
import jsbi from 'jsbi';
import {
  Quote,
  SerializableAccountInfo,
  SerializableQuote
} from './types.js';

const JSBI = defaultImport(jsbi);

function toPairString(mintA: string, mintB: string): string {
  if (mintA < mintB) {
    return `${mintA}-${mintB}`;
  } else {
    return `${mintB}-${mintA}`;
  }
}

function toSerializableAccountInfo(
  accountInfo: AccountInfo<Buffer>,
): SerializableAccountInfo {
  return {
    data: new Uint8Array(accountInfo.data),
    executable: accountInfo.executable,
    lamports: accountInfo.lamports,
    owner: accountInfo.owner.toBase58(),
    rentEpoch: accountInfo.rentEpoch,
  };
}

function toAccountInfo(
  accountInfo: SerializableAccountInfo,
): AccountInfo<Buffer> {
  return {
    data: Buffer.from(accountInfo.data),
    executable: accountInfo.executable,
    lamports: accountInfo.lamports,
    owner: new PublicKey(accountInfo.owner),
    rentEpoch: accountInfo.rentEpoch,
  };
}


function toSerializableQuote(quote: Quote): SerializableQuote {
  return {
    in: quote.in.toString(), out: quote.out.toString(), tipBps: quote.tipBps, quote: quote.quote
  };
}

function toQuote(quote: SerializableQuote): Quote {
  return {
    in: JSBI.BigInt(quote.in),
    out: JSBI.BigInt(quote.out),
    tipBps: quote.tipBps,
    quote: quote.quote
  }
}

export {
  toAccountInfo, toPairString, toQuote, toSerializableAccountInfo, toSerializableQuote
};

