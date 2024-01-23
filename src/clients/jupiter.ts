import jup, { createJupiterApiClient, querystring } from '@jup-ag/api';
import https from 'https';
import http from 'http';
import fetch from 'node-fetch';
import { config } from '../config.js';

const JUPITER_URL = config.get('jupiter_url');

function createBaseJupiterApiClient(config: jup.ConfigurationParameters) {
  return createJupiterApiClient({
    ...config,
    queryParamsStringify: (params) => {
      if (params['excludeDexes']) {
        params['excludeDexes'] = (params['excludeDexes'] as string[]).join(',');
      }
      if (params['dexes']) {
        params['dexes'] = (params['dexes'] as string[]).join(',');
      }
      return querystring(params);
    },
  });
}

const keepaliveOptions: https.AgentOptions | http.AgentOptions = {
  timeout: 4000,
  maxSockets: 2048,
  keepAlive: true,
  keepAliveMsecs: 5000,
};

const keepaliveAgent = JUPITER_URL.startsWith('https')
  ? new https.Agent(keepaliveOptions)
  : new http.Agent(keepaliveOptions);

const fetchWithKeepalive = (url, options) => {
  options = options || {};
  options.agent = keepaliveAgent;
  return fetch(url, options);
};

const jupiterClient = createBaseJupiterApiClient({
  basePath: config.get('jupiter_url'),
  fetchApi: fetchWithKeepalive
});

export { jupiterClient };
