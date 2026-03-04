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

const fs = require('fs');
const ora = require('ora');
const fromFile = require('../utils/fromFile');
const compare = require('./compare');

module.exports = async (args, result) => {

  result = result || {
    added: [],
    modified: [],
    deleted: [],
    behind: [],
    unchanged: [],
  };

  const propertyId = args.propertyId;
  const reactor = args.reactor;
  const base = args.baseDir || '.';
  const propertyPath = `${base}/${propertyId}`;
  const dataElementsPath = `${propertyPath}/data_elements`;

  // If the local directory doesn't exist, skip this resource type entirely.
  // This avoids reporting all remote resources as "Behind" when the user
  // intentionally excluded this type from the pull.
  if (!fs.existsSync(dataElementsPath)) {
    return result;
  }

  const spinner = ora('Diffing Data Elements \n');
  spinner.color = 'red';
  spinner.start();

  // get all of the local files
  const files = fs.readdirSync(dataElementsPath);

  // get all of the remote objects
  // In environment mode (args.buildId set), read from the published build instead of drafts.
  const remotes = args.buildId
    ? (await reactor.getDataElementsForBuild(args.buildId)).data
    : (await reactor.listDataElementsForProperty(args.propertyId, { 'page[size]': 999 })).data;

  // Track which remote IDs we've already matched during the local loop.
  const seenIds = new Set();

  for (const file of files) {

    // Only process real ID-based directories; symlinks (starting with _) are
    // human-readable aliases created by toFiles.js and must not be processed.
    if (!file.startsWith('DE')) {
      continue;
    }

    const localPath = `${dataElementsPath}/${file}`;

    // get the local object from file
    const local = await fromFile(localPath, args);
    seenIds.add(local.id);
    // get the object from launch
    const remote = remotes.find((remote) => (local.id === remote.id));

    // diff compare
    const comparison = compare(local, remote, result);
    result[comparison.result]
    .push({
      type: local.type,
      id: local.id,
      path: localPath,
      details: comparison.details,
    });

  }

  for (const remote of remotes) {

    // we only want to sync things that haven't been handled above.
    // just the remotes that haven't even been created here
    if (!seenIds.has(remote.id)) {

      // diff compare
      const comparison = compare(null, remote, result);
      result[comparison.result]
      .push({
        type: remote.type,
        id: remote.id,
        path: `${dataElementsPath}/${remote.id}`,
        details: comparison.details,
      });

    }

  }

  spinner.stop();

  return result;
};