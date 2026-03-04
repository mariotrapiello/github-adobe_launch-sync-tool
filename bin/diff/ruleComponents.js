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
  const ruleComponentsPath = `${propertyPath}/rule_components`;

  // If the local directory doesn't exist, skip this resource type entirely.
  // This avoids reporting all remote resources as "Behind" when the user
  // intentionally excluded this type from the pull.
  if (!fs.existsSync(ruleComponentsPath)) {
    return result;
  }

  const spinner = ora('Diffing Rule Components \n');
  spinner.color = 'green';
  spinner.start();

  // get all of the local files
  const files = fs.readdirSync(ruleComponentsPath);

  // get all of the remote objects
  // In environment mode (args.buildId set), read rules from the published build instead of drafts.
  // Rule components have no build-scoped endpoint; they are always fetched per-rule.
  const rules = args.buildId
    ? (await reactor.listRulesForBuild(args.buildId, { 'page[size]': 999 })).data
    : (await reactor.listRulesForProperty(args.propertyId, { 'page[size]': 999 })).data;
  let remotes = [];
  // Await all rule component fetches before comparing — the original code
  // pushed promises but never awaited them, causing a race condition where
  // remotes was still empty/incomplete when the file loop ran.
  await Promise.all(
    rules.map((rule) =>
      reactor.listRuleComponentsForRule(rule.id, { 'page[size]': 999 })
        .then(({ data }) => { remotes = remotes.concat(data); })
    )
  );

  // Track which remote IDs we've already matched during the local loop.
  const seenIds = new Set();

  for (const file of files) {

    // Only process real ID-based directories; symlinks (starting with _) are
    // human-readable aliases created by toFiles.js and must not be processed.
    if (!file.startsWith('RC')) {
      continue;
    }

    const localPath = `${ruleComponentsPath}/${file}`;

    // get the local object from file
    const local = await fromFile(localPath, args);
    seenIds.add(local.id);
    // get the object from launch
    const remote = remotes.find((remote) => (local.id === remote.id));

    // diff compare
    let comparison = compare(local, remote, result);
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
        path: `${ruleComponentsPath}/${remote.id}`,
        details: comparison.details,
      });

    }

  }

  spinner.stop();

  return result;
};