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

const checkAccessToken = require('./utils/getAccessToken');
const getReactor = require('./utils/getReactor');
const fromFile = require('./utils/fromFile');
const toFiles = require('./utils/toFiles');
const checkArgs = require('./utils/checkArgs');
const toMethodName = require('./utils/resourceName');
const diff = require('./diff');


async function updateExtension(reactor, local) {
  return (await reactor.updateExtension(
    local.id,
    { data: {
      id: local.id,
      type: local.type,
      attributes: local.attributes,
      relationships: local.relationships 
    }})).data;
}

async function updateResource(reactor, local) {
  // true = singular: data_elements → DataElement, rule_components → RuleComponent
  const resourceName = toMethodName(local.type, true);
  const update = (await reactor[`update${resourceName}`]({
    id: local.id,
    type: local.type,
    attributes: local.attributes
  })).data;
  await maybeRevise(resourceName, reactor, local);
  return update;
}

async function updateExtensionOr(reactor, local) {
  if (local.type === 'extensions') return await updateExtension(reactor, local);
  return await updateResource(reactor, local);
}

async function maybeRevise(resourceName, reactor, local) {
  // Original had: resourceName === ('Extension' || 'DataElement')
  // which always evaluated to resourceName === 'Extension' (JS OR short-circuit bug).
  if (resourceName === 'Extension' || resourceName === 'DataElement')
    return await reactor[`revise${resourceName}`](local.id);
}

module.exports = async (args) => {
  const settings = checkArgs(args);

  args.propertyId  = settings.propertyId;
  args.environment = settings.environment;
  args.integration = settings.integration;
  args.baseDir     = settings.baseDir;

  settings.accessToken = await checkAccessToken(settings);
  const reactor = await getReactor(settings);
  const result = await diff(args);

  if (args.ci) {
    if (result.behind.length > 0) {
      console.error(`\nCI SYNC ABORTED: ${result.behind.length} resource(s) in Launch are newer than your local copy.`);
      console.error('Someone may have edited these directly in the Launch UI after your last pull.\n');
      console.error('Conflicting resources (pull these first):');
      result.behind.forEach((c) => console.error(`  [BEHIND]   ${c.path}`));

      if (result.modified.length > 0) {
        console.error('\nThese local changes were NOT synced because of the conflict above:');
        result.modified.forEach((c) => console.error(`  [BLOCKED]  ${c.path}`));
      }

      console.error('\nTo resolve: run pull locally, review the conflicting resources, commit, then push again.');
      process.exit(1);
    }
    if (result.modified.length === 0) {
      console.log('Nothing to sync.');
      return;
    }
    console.log(`Syncing ${result.modified.length} modified resource(s)...`);
    for (const comparison of result.modified) {
      const local = await fromFile(comparison.path, args);
      const updated = await updateExtensionOr(reactor, local);
      await toFiles(updated, args);
    }
    return;
  }

  // added
  // for (const comparison of result.added) {
  //   // TODO: 
  // }

  // modified
  if (
    !args.behind ||
    args.modified
  ) {

    console.log('🔂 Syncing Modified.');

    for (const comparison of result.modified) {
      const local = await fromFile(comparison.path, args);
      // sync it
      const updated = await updateExtensionOr(reactor, local);

      // Persist the updated files back in the form it is supposed to look like:
      await toFiles(updated, args); 
    }
  }

  // behind
  if (
    !args.modified ||
    args.behind
  ) {

    console.log('↩️  Syncing behind.');

    for (const comparison of result.behind) {
      const resourceMethodName = toMethodName(comparison.type, true);
      const updated = (await reactor[`get${resourceMethodName}`](comparison.id)).data;
      
      await toFiles(updated, args); 
    }
  }

  // unchanged
  // for (const comparison of result.unchanged) {
  //   // TODO: 
  // }

};
