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
const publish = require('./publish');


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
  
  let targetId = local.id;

  try {
    // 1. Try to update the current ID.
    let updated = (await reactor[`update${resourceName}`]({
      id: targetId,
      type: local.type,
      attributes: local.attributes
    })).data;

    // 2. DataElements and Extensions must be revised (creating a numbered revision)
    //    before they can be added to a library. Do this automatically after each update.
    if (resourceName === 'DataElement' || resourceName === 'Extension') {
      console.log(`  [REVISE]   Creating publishable revision for ${updated.id}...`);
      updated = (await reactor[`revise${resourceName}`](updated.id)).data;
      console.log(`  [REVISE]   New revision: ${updated.id}`);
    }

    return updated;
  } catch (e) {
    // 3. If it fails because the revision is frozen (common in Environment Mode),
    //    find the head (draft) revision or create a new one, then update it.
    if (e.status === 409 || (e.responseBody && e.responseBody.errors && e.responseBody.errors[0].code === 'read-only')) {
      console.log(`  [REVISE]   Resource ${local.id} is frozen. Finding/creating a new draft...`);
      
      // Get the current resource to find its origin
      const current = (await reactor[`get${resourceName}`](local.id)).data;
      const originId = current.relationships.origin.data.id;

      // Find the head revision for this origin — sort by revision_number desc
      const revisions = (await reactor[`listRevisionsFor${resourceName}`](originId, {
        'page[size]': 1,
        'sort': '-revision_number'
      })).data;

      const head = revisions[0];
      targetId = head.id;

      // If the head is locked (published, or in a submitted/approved library),
      // revise it to create a new editable draft. We detect "locked" by attempting
      // the update and catching a 409 — checking attributes alone is unreliable
      // because a resource can be frozen due to its library state (submitted/approved)
      // even when review_status is 'unsubmitted' and published is false.
      try {
        console.log(`  [REVISE]   Updating draft revision: ${targetId}`);
        let updated = (await reactor[`update${resourceName}`]({
          id: targetId,
          type: local.type,
          attributes: local.attributes
        })).data;

        if (resourceName === 'DataElement' || resourceName === 'Extension') {
          console.log(`  [REVISE]   Creating publishable revision for ${updated.id}...`);
          updated = (await reactor[`revise${resourceName}`](updated.id)).data;
          console.log(`  [REVISE]   New revision: ${updated.id}`);
        }

        return updated;
      } catch (e2) {
        if (e2.status !== 409 && !(e2.responseBody && e2.responseBody.errors && e2.responseBody.errors[0].code === 'read-only')) {
          throw e2;
        }
        // Head is also frozen — create a truly new draft via revise.
        console.log(`  [REVISE]   Head revision ${targetId} is also locked. Creating new draft...`);
        const revised = (await reactor[`revise${resourceName}`](targetId)).data;
        targetId = revised.id;
      }

      // Apply the local changes to the new draft (reached only when head was also locked).
      console.log(`  [REVISE]   Updating new draft: ${targetId}`);
      let updated = (await reactor[`update${resourceName}`]({
        id: targetId,
        type: local.type,
        attributes: local.attributes
      })).data;

      if (resourceName === 'DataElement' || resourceName === 'Extension') {
        console.log(`  [REVISE]   Creating publishable revision for ${updated.id}...`);
        updated = (await reactor[`revise${resourceName}`](updated.id)).data;
        console.log(`  [REVISE]   New revision: ${updated.id}`);
      }

      return updated;
    }
    throw e;
  }
}

async function updateExtensionOr(reactor, local) {
  if (local.type === 'extensions') return await updateExtension(reactor, local);
  return await updateResource(reactor, local);
}

// maybeRevise is now handled inside updateResource for better flow
async function maybeRevise(resourceName, reactor, local) {
  // no-op, logic moved to updateResource
}

module.exports = async (args) => {
  const settings = checkArgs(args);

  args.propertyId    = settings.propertyId;
  args.environment   = settings.environment;
  args.integration   = settings.integration;
  args.baseDir       = settings.baseDir;
  args.environmentId = settings.environmentId;

  settings.accessToken = await checkAccessToken(settings);
  const reactor = await getReactor(settings);

  // Staging and production do not push local changes to drafts — they only
  // promote the existing git-sync-* library up the approval chain.
  // The environment type is resolved inside publish.js from the API.
  if (settings.environmentId) {
    const env = (await reactor.getEnvironment(settings.environmentId)).data;
    const envStage = env.attributes.stage;
    if (envStage === 'staging' || envStage === 'production') {
      await publish(reactor, settings.propertyId, [], settings.environmentId);
      return;
    }
  }

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
    const updatedResources = [];
    for (const comparison of result.modified) {
      const local = await fromFile(comparison.path, args);
      const updated = await updateExtensionOr(reactor, local);
      await toFiles(updated, args);
      // Use the actual updated ID (may differ if a new draft was created for a frozen revision)
      updatedResources.push({ id: updated.id, type: updated.type });
    }

    // Environment mode: after pushing drafts, publish a library to the target environment.
    if (settings.environmentId) {
      if (updatedResources.length > 0) {
        await publish(reactor, settings.propertyId, updatedResources, settings.environmentId);
      } else {
        const getEnvironmentBuildId = require('./utils/getEnvironmentBuildId');
        const existingBuildId = await getEnvironmentBuildId(reactor, settings.environmentId);
        if (!existingBuildId) {
          console.log(
            '\n[INFO] No build exists for this environment and there are no local changes to sync.\n' +
            '       To create a new build, modify at least one resource locally and run sync again.'
          );
        }
      }
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

    const updatedResources = [];
    for (const comparison of result.modified) {
      const local = await fromFile(comparison.path, args);
      const updated = await updateExtensionOr(reactor, local);
      await toFiles(updated, args);
      // Use the actual updated ID (may differ if a new draft was created for a frozen revision)
      updatedResources.push({ id: updated.id, type: updated.type });
    }

    // Environment mode: publish after syncing drafts (non-CI interactive mode).
    if (settings.environmentId) {
      if (updatedResources.length > 0) {
        await publish(reactor, settings.propertyId, updatedResources, settings.environmentId);
      } else {
        const getEnvironmentBuildId = require('./utils/getEnvironmentBuildId');
        const existingBuildId = await getEnvironmentBuildId(reactor, settings.environmentId);
        if (!existingBuildId) {
          console.log(
            '\n[INFO] No build exists for this environment and there are no local changes to sync.\n' +
            '       To create a new build, modify at least one resource locally and run sync again.'
          );
        }
      }
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
