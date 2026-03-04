const ora = require('ora');
const path = require('path');
const deleteDirectory = require('./utils/deleteDirectory');
const writeResources = require('./utils/writeResources');
const checkAccessToken = require('./utils/getAccessToken');
const checkArgs = require('./utils/checkArgs');
const getReactor = require('./utils/getReactor');
const getEnvironmentBuildId = require('./utils/getEnvironmentBuildId');

const resourceTypes = [
  'data_elements',
  'rules',
  'rule_components',
  // 'extensions',
];

function startSpinner() {
  const spinner = ora('Pulling Resources \n');
  spinner.color = 'blue';
  return spinner.start();
}

async function setSettings(args) {
  const settings = checkArgs(args);
  settings.accessToken = await checkAccessToken(settings);
  settings.reactor = await getReactor(settings);

  // Environment mode: fetch resources from the last succeeded build of the target environment.
  // If no build exists (e.g. environment was never built, or its library was deleted),
  // fall back to draft mode so pull/diff/sync still work correctly.
  if (settings.environmentId) {
    const buildId = await getEnvironmentBuildId(settings.reactor, settings.environmentId);
    if (buildId) {
      settings.buildId = buildId;
    } else {
      console.warn(
        `[WARN] No succeeded build found for environment ${settings.environmentId}.\n` +
        '       Falling back to draft mode for pull/diff.\n' +
        '       Run sync to create a new build and restore the environment state.'
      );
    }
  }

  return settings;
}

async function pull(args) {
  const spinner = startSpinner();
  const settings = await setSettings(args);

  // Clean up local property directory first to ensure a 1:1 copy.
  // This removes any local files that no longer exist in Adobe Launch.
  const propertyDir = path.join(settings.baseDir, settings.propertyId);
  console.log(`\nCleaning up local directory: ${propertyDir}`);
  deleteDirectory(propertyDir);

  writeResources(resourceTypes, settings);
  spinner.stop();
}

module.exports = pull;
