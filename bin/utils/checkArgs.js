const fs = require('fs');
const path = require('path');

// integration.config.json (committed) — non-sensitive config: scopes, etc.
// integration.json (gitignored) — sensitive credentials: clientId, clientSecret, orgId.
// Both files are merged so the rest of the code sees a single integration object.
const INTEGRATION_CONFIG_PATH = path.resolve(process.cwd(), 'integration.config.json');
const INTEGRATION_PATH = path.resolve(process.cwd(), 'integration.json');

function loadIntegration() {
  if (!fs.existsSync(INTEGRATION_CONFIG_PATH)) {
    throw new Error(
      `integration.config.json not found at ${INTEGRATION_CONFIG_PATH}. ` +
      'This file should be committed to the repo and contains non-sensitive config (scopes).'
    );
  }
  if (!fs.existsSync(INTEGRATION_PATH)) {
    throw new Error(
      `integration.json not found at ${INTEGRATION_PATH}. ` +
      'Create it with your clientId, clientSecret, and orgId (never commit this file).'
    );
  }
  const config = JSON.parse(fs.readFileSync(INTEGRATION_CONFIG_PATH, 'utf8'));
  const secrets = JSON.parse(fs.readFileSync(INTEGRATION_PATH, 'utf8'));
  // Secrets win over config defaults (e.g. scopes can be overridden locally)
  return Object.assign({}, config, secrets);
}

function checkSettings(args) {
  const settingsPath = args.settingsPath || './reactor-settings.json';
  if (!fs.existsSync(settingsPath)) {
    throw new Error(`Property settings file not found at: ${settingsPath}`);
  }
  const propertySettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const integration = loadIntegration();

  // baseDir: directory containing the settings file. Pull output goes here,
  // so each property's files land inside properties/<name>/PR.../ instead of
  // at the repo root.
  const baseDir = path.dirname(path.resolve(settingsPath));

  // Merge: property settings win over integration defaults, but integration
  // always provides the credentials block.
  return Object.assign({}, propertySettings, { integration, baseDir });
}

function checkEnvironment(settings) {
  if (!settings.environment) {
    throw new Error('No "environment" property in settings file.');
  }
  if (!settings.environment.reactorUrl) {
    throw new Error('No "environment.reactorUrl" property in settings file.');
  }
  return settings.environment;
}

function checkArgs(args) {
  const settings = checkSettings(args);
  checkEnvironment(settings);
  return settings;
}

module.exports = checkArgs;