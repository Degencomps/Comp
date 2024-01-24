import { Keypair } from '@solana/web3.js';
import { config } from '../config.js';

import * as fs from 'fs';
import { searcher } from 'jito-ts';

const BLOCK_ENGINE_URLS = config.get('block_engine_urls');
const AUTH_KEYPAIR_PATHS = config.get('auth_keypair_path');

// const GEYSER_URL = config.get('geyser_url');
// const GEYSER_ACCESS_TOKEN = config.get('geyser_access_token');

function readKeypairFromFile(path: string): Keypair {
  const decodedKey = new Uint8Array(
    JSON.parse(fs.readFileSync(path).toString()) as number[],
  );
  return Keypair.fromSecretKey(decodedKey);
}

// Create a keypair for each path
const keypairs = AUTH_KEYPAIR_PATHS.map(readKeypairFromFile);

class RoundRobinSearcherClientManager {
  private mempoolClients: searcher.SearcherClient[] = [];
  private sendClients: searcher.SearcherClient[] = [];
  private sendIndex: number;

  constructor(urls: string[], keypairs: Keypair[]) {
    // we send to only the first url, but rotate keypairs
    keypairs.forEach((keypair) => {
      const sendClient = searcher.searcherClient(urls[0], keypair, {
        'grpc.keepalive_timeout_ms': 4000,
      });
      this.sendClients.push(sendClient);
    });

    // we read from all urls for mempool updates, but a single keypair
    urls.forEach(url => {
      const readClient = searcher.searcherClient(url, keypairs[0], {
        'grpc.keepalive_timeout_ms': 4000,
      });
      this.mempoolClients.push(readClient);
    })

    this.sendIndex = 0;
  }

  getNextSendClient(): searcher.SearcherClient {
    const client = this.sendClients[this.sendIndex];
    this.sendIndex = (this.sendIndex + 1) % this.sendClients.length;
    return client;
  }

  getAllSendClients(): searcher.SearcherClient[] {
    return this.sendClients;
  }

  getDefaultMempoolClient(): searcher.SearcherClient {
    return this.mempoolClients[0];
  }

  getAllMempoolClients(): searcher.SearcherClient[] {
    return this.mempoolClients;
  }
}

// const geyserClient = jitoGeyserClient(GEYSER_URL, GEYSER_ACCESS_TOKEN, {
//   'grpc.keepalive_timeout_ms': 4000,
// });

// all bundles sent get automatically forwarded to the other regions.
// assuming the first block engine in the array is the closest one
// const searcherClient = searcherClients[0];

const searcherClientManager = new RoundRobinSearcherClientManager(BLOCK_ENGINE_URLS, keypairs);

export { searcherClientManager };
