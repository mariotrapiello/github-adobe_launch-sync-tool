/*
Copyright 2019 Adobe. All rights reserved.
This file is licensed to you under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License. You may obtain a copy
of the License at http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed under
the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
OF ANY KIND, either express or implied. See the License for the specific language
governing permissions and limitations under the License.
*/

const checkArgs = require('./utils/checkArgs');
const checkAccessToken = require('./utils/getAccessToken');
const getReactor = require('./utils/getReactor');
const getEnvironmentBuildId = require('./utils/getEnvironmentBuildId');
const diffProperty = require('./diff/property');

module.exports = async (args) => {
  const settings = checkArgs(args);

  args.propertyId     = settings.propertyId;
  args.environment    = settings.environment;
  args.integration    = settings.integration;
  args.baseDir        = settings.baseDir;
  args.environmentId  = settings.environmentId;

  if (!args.accessToken) {
    args.accessToken = await checkAccessToken(settings);
    settings.accessToken = args.accessToken;
  }

  if (!args.reactor) {
    args.reactor = await getReactor(settings);
  }

  // Environment mode: resolve the most recent succeeded build and attach to args
  // so diff sub-modules use build-scoped endpoints instead of property drafts.
  if (settings.environmentId && !args.buildId) {
    const buildId = await getEnvironmentBuildId(args.reactor, settings.environmentId);
    if (buildId) {
      args.buildId = buildId;
    } else {
      console.warn(`[WARN] No succeeded build found for environment ${settings.environmentId}. Falling back to draft mode.`);
    }
  }

  const result = await diffProperty(args);
  return result;
};
