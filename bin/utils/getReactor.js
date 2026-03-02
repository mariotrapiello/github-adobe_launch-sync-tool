const Reactor = require('@adobe/reactor-sdk').default;

async function getReactor(settings) {
  if (!settings.reactor) {
    const customHeaders = {};

    // x-gw-ims-org-id is required by the Reactor API to identify the IMS org.
    if (settings.integration && settings.integration.orgId) {
      customHeaders['x-gw-ims-org-id'] = settings.integration.orgId;
    }

    // Override the hardcoded 'Activation-DTM' API key with the real clientId.
    if (settings.integration && settings.integration.clientId) {
      customHeaders['X-Api-Key'] = settings.integration.clientId;
    }

    return new Reactor(settings.accessToken, {
      reactorUrl: settings.environment.reactorUrl,
      enableLogging: false, // set true to debug requests
      customHeaders
    });
  }
  return settings.reactor;
}

module.exports = getReactor;