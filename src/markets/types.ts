import { QuoteResponse } from '@jup-ag/api';
import { AccountInfo } from '@solana/web3.js';
import { BASE_MINTS_OF_INTEREST } from '../constants.js';
import { JsbiType } from '../types.js';
import { JupiterDexProgramLabel } from './jupiter/index.js';
import { toPairString } from './utils.js';

export type BASE_MINT_OF_INTEREST = typeof BASE_MINTS_OF_INTEREST;

export type Market = {
  tokenMintA: string;
  tokenVaultA: string;
  tokenMintB: string;
  tokenVaultB: string;
  dexLabel: JupiterDexProgramLabel;
  id: string;
};

export abstract class DEX {
  pairToMarkets: Map<string, Market[]>;
  ammCalcAddPoolMessages: AmmCalcWorkerParamMessage[];

  constructor() {
    this.pairToMarkets = new Map();
    this.ammCalcAddPoolMessages = [];
  }

  getAmmCalcAddPoolMessages(): AmmCalcWorkerParamMessage[] {
    return this.ammCalcAddPoolMessages;
  }

  getMarketsForPair(mintA: string, mintB: string): Market[] {
    const markets = this.pairToMarkets.get(toPairString(mintA, mintB));
    if (markets === undefined) {
      return [];
    }
    return markets;
  }

  getAllMarkets(): Market[] {
    return Array.from(this.pairToMarkets.values()).flat();
  }
}

export type AccountInfoMap = Map<string, AccountInfo<Buffer> | null>;
export type SerializableAccountInfoMap = Map<
  string,
  SerializableAccountInfo | null
>;

export type AddPoolParamPayload = {
  poolLabel: JupiterDexProgramLabel;
  id: string;
  feeRateBps: number;
  serializableAccountInfo: SerializableAccountInfo;
  params?: any;
};

export type AddPoolResultPayload = {
  id: string;
  success: boolean;
  accountsForUpdate: string[];
};

export type CalculateQuoteParamPayload = {
  id: string;
  params: SerializableQuoteParams;
};

export type CalculateQuoteResultPayload = {
  quote: SerializableJupiterQuote | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error?: any;
};

export type CalculateJupiterQuotesParamPayload = {
  balancingLeg: SerializableLegFixed;
  mirroringLeg: SerializableLeg;
  balancingLegFirst: boolean;
};

export type CalculateJupiterBestQuoteParamPayload = CalculateJupiterQuotesParamPayload & {
  victimTxnSignature: string;
}

export type CalculateJupiterQuotesResultPayload = {
  quotes: SerializableQuote[]
}

export type CalculateJupiterBestQuoteResultPayload = {
  quote: SerializableQuote;
  profit: string;
}

export type AmmCalcWorkerParamMessage =
  | {
    type: 'addPool';
    payload: AddPoolParamPayload;
  }
  | {
    type: 'calculateQuote';
    payload: CalculateQuoteParamPayload;
  }
  | {
    type: 'calculateJupiterQuotes',
    payload: CalculateJupiterQuotesParamPayload;
  }
  | {
  type: 'calculateJupiterBestQuote',
  payload: CalculateJupiterBestQuoteParamPayload;
  };

export type AmmCalcWorkerResultMessage =
  | {
    type: 'addPool';
    payload: AddPoolResultPayload;
  }
  | {
    type: 'calculateQuote';
    payload: CalculateQuoteResultPayload;
  }
  | {
    type: 'calculateJupiterQuotes',
    payload: CalculateJupiterQuotesResultPayload;
  }
  | {
  type: 'calculateJupiterBestQuote',
  payload: CalculateJupiterBestQuoteResultPayload;
  };

export type SerializableAccountInfo = {
  executable: boolean;
  owner: string;
  lamports: number;
  data: Uint8Array;
  rentEpoch?: number;
};

export type SerializableJupiterQuote = {
  notEnoughLiquidity: boolean;
  minInAmount?: string;
  minOutAmount?: string;
  inAmount: string;
  outAmount: string;
  feeAmount: string;
  feeMint: string;
  feePct: number;
  priceImpactPct: number;
};

export type SerializableQuoteParams = {
  sourceMint: string;
  destinationMint: string;
  amount: string;
};

export type SerializableLeg = {
  sourceMint: string;
  destinationMint: string;
};

export type SerializableLegFixed = SerializableLeg & {
  marketId: string;
  dex: JupiterDexProgramLabel;
  in: string;
  estimatedOutExcludingFees: string
};

export type Quote = { in: JsbiType; out: JsbiType; quote: QuoteResponse };

export type SerializableQuote = {
  in: string;
  out: string;
  quote: QuoteResponse
};
