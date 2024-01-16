import jup, { createJupiterApiClient, querystring } from '@jup-ag/api';
import { config } from '../config.js';

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

const jupiterClient = createBaseJupiterApiClient({
  basePath: config.get('jupiter_url'),
});

export { jupiterClient };
