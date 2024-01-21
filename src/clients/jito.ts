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
  private clients: searcher.SearcherClient[];
  private index: number;

  constructor(urls: string[], keypairs: Keypair[]) {
    this.clients = [];
    urls.forEach((url) => {
      keypairs.forEach((keypair) => {
        const client = searcher.searcherClient(url, keypair, {
          'grpc.keepalive_timeout_ms': 4000,
        });
        this.clients.push(client);
      });
    });
    this.index = 0;
  }

  getNextClient(): searcher.SearcherClient {
    const client = this.clients[this.index];
    this.index = (this.index + 1) % this.clients.length;
    return client;
  }

  getDefaultClient(): searcher.SearcherClient {
    return this.clients[0];
  }

  getAllClients(): searcher.SearcherClient[] {
    return this.clients;
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
