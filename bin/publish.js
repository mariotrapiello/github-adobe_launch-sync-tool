// Publishes resources to a specific Launch environment after they have been
// synced to drafts. The behaviour depends on the environment stage:
//
//   development  → Create a fresh git-sync-* library, add resources, build.
//                  The library stays in "development" state — NO submit.
//                  Multiple dev syncs are allowed without blocking each other.
//   staging      → Find the latest git-sync-* library in state "development",
//                  submit it, build it for staging. Stays "submitted" for QA.
//   production   → Find the latest git-sync-* library in state "submitted",
//                  approve it, assign production environment, final build.
//
// Promotion chain (mirrors the Launch UI flow):
//   dev sync:     build in dev    → stays "development"
//   staging sync: submit → build  → stays "submitted"  (do QA here)
//   prod sync:    approve → build → published

const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 120000;

async function pollBuildStatus(reactor, buildId) {
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const build = (await reactor.getBuild(buildId)).data;
    const status = build.attributes.status;
    if (status === 'succeeded') return build;
    if (status === 'failed') throw new Error(`Build ${buildId} failed.`);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Build ${buildId} timed out after ${POLL_TIMEOUT_MS / 1000}s.`);
}

async function createBuildAndPoll(reactor, libraryId) {
  const build = (await reactor.createBuild(libraryId)).data;
  console.log(`  Build ${build.id} triggered — polling for completion...`);
  return pollBuildStatus(reactor, build.id);
}

// Separate modified resources by type for adding to the library.
function groupByType(modifiedResources) {
  const rules = [];
  const dataElements = [];
  const extensions = [];
  for (const r of modifiedResources) {
    if (r.type === 'rules') rules.push({ id: r.id, type: 'rules' });
    else if (r.type === 'data_elements') dataElements.push({ id: r.id, type: 'data_elements' });
    else if (r.type === 'extensions') extensions.push({ id: r.id, type: 'extensions' });
  }
  return { rules, dataElements, extensions };
}

// Find the most recently created git-sync-* library in the given state(s).
async function findGitSyncLibrary(reactor, propertyId, states) {
  const stateList = Array.isArray(states) ? states : [states];
  let candidate = null;

  for (const state of stateList) {
    const libs = (await reactor.listLibrariesForProperty(propertyId, {
      'filter[state]': state,
      'page[size]': 100
    })).data;

    const gitSyncLibs = libs
      .filter((lib) => lib.attributes.name.startsWith('git-sync-') && lib.attributes.state === state)
      .sort((a, b) => new Date(b.meta.created_at) - new Date(a.meta.created_at));

    if (gitSyncLibs.length > 0) {
      const latest = gitSyncLibs[0];
      if (!candidate || new Date(latest.meta.created_at) > new Date(candidate.meta.created_at)) {
        candidate = latest;
      }
    }
  }

  return candidate;
}

module.exports = async function publish(reactor, propertyId, modifiedResources, environmentId) {
  // Resolve the Launch environment type to determine the correct transition flow.
  const env = (await reactor.getEnvironment(environmentId)).data;
  const envStage = env.attributes.stage; // 'development' | 'staging' | 'production'
  console.log(`\nPublishing to Launch environment: ${env.attributes.name} (${envStage})`);

  // ─────────────────────────────────────────────────────────────────────────
  // DEVELOPMENT
  // Create a fresh git-sync-* library with only our modified resources and
  // trigger a build. This is the entry point of the promotion chain.
  // ─────────────────────────────────────────────────────────────────────────
  if (envStage === 'development') {
    if (!modifiedResources || modifiedResources.length === 0) {
      console.log('Nothing to publish (no modified resources).');
      return;
    }

    // If the target environment is already assigned to another library in
    // development state, unlink it first (library is preserved, just freed).
    const existingLibraries = (await reactor.listLibrariesForProperty(propertyId, {
      'filter[state]': 'development',
      'page[size]': 100
    })).data;

    const occupied = existingLibraries.find((lib) => {
      const rel = lib.relationships && lib.relationships.environment && lib.relationships.environment.data;
      return rel && rel.id === environmentId && lib.attributes.state === 'development';
    });

    if (occupied) {
      console.log(`  Unlinking environment from existing library ${occupied.id} (library preserved, only the environment link is removed)...`);
      await reactor.removeEnvironmentRelationshipFromLibrary(occupied.id, environmentId);
    }

    // Create a fresh library with only our changes.
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const library = (await reactor.createLibrary(propertyId, {
      attributes: { name: `git-sync-${timestamp}` },
      type: 'libraries'
    })).data;
    const libraryId = library.id;
    console.log(`  Library created: ${libraryId}`);

    await reactor.setEnvironmentRelationshipForLibrary(libraryId, environmentId);

    const { rules, dataElements, extensions } = groupByType(modifiedResources);
    if (rules.length > 0)
      await reactor.addRuleRelationshipsToLibrary(libraryId, rules);
    if (dataElements.length > 0)
      await reactor.addDataElementRelationshipsToLibrary(libraryId, dataElements);
    if (extensions.length > 0)
      await reactor.addExtensionRelationshipsToLibrary(libraryId, extensions);

    const build = await createBuildAndPoll(reactor, libraryId);
    console.log(`  Build succeeded: ${build.id}`);

    // Library intentionally stays in "development" state after the build.
    // The submit step happens when the staging branch runs sync, ensuring
    // multiple dev syncs can be done without "Upstream blocked" conflicts.
    console.log('✅ Published to development environment.');
    console.log('   Library is in "development" state and ready to be promoted.');
    console.log('   Next step: merge to the staging branch to promote to staging.');

  // ─────────────────────────────────────────────────────────────────────────
  // STAGING
  // Find the latest git-sync-* library in "development" state (left there
  // by the dev sync), submit it, assign the staging environment, and build.
  // The library stays in "submitted" state — NO approve yet.
  // QA happens in staging; the approve step is done by the prod sync.
  // ─────────────────────────────────────────────────────────────────────────
  } else if (envStage === 'staging') {
    // Block if there is already a git-sync-* library in "submitted" state
    // waiting to be approved/promoted to production. Force the user to run
    // the prod sync first (which will approve and publish it).
    const submittedLibraries = (await reactor.listLibrariesForProperty(propertyId, {
      'filter[state]': 'submitted',
      'page[size]': 100
    })).data;

    const submittedBlocking = submittedLibraries.find((lib) =>
      lib.attributes && lib.attributes.name && lib.attributes.name.startsWith('git-sync-') &&
      lib.attributes.state === 'submitted'
    );
    if (submittedBlocking) {
      console.warn(
        `\n⚠️  Cannot promote to staging: library "${submittedBlocking.attributes.name}" (${submittedBlocking.id}) is already in "submitted" state waiting to be promoted to production.\n` +
        '   Run sync on the prod branch to approve and publish it first, then re-run the staging sync.\n'
      );
      return;
    }

    const library = await findGitSyncLibrary(reactor, propertyId, 'development');
    if (!library) {
      console.warn(
        '\n⚠️  Cannot promote to staging: no git-sync-* library found in "development" state.\n' +
        '   You must publish to development first (sync on the dev branch) before promoting to staging.\n'
      );
      return;
    }
    const libraryId = library.id;
    console.log(`  Promoting library ${libraryId} ("${library.attributes.name}") to staging...`);

    // Submit the library — this moves it out of "development" into the
    // promotion pipeline. Intentionally done here (not during dev sync) so
    // that multiple dev syncs can be done without blocking each other.
    await reactor.transitionLibrary(libraryId, 'submit');
    console.log(`  Library submitted.`);

    // Remove any previously assigned environment (e.g. the dev environment)
    // before assigning the staging one.
    const currentEnvRel = await reactor.getEnvironmentRelationshipForLibrary(libraryId);
    if (currentEnvRel && currentEnvRel.data && currentEnvRel.data.id !== environmentId) {
      console.log(`  Removing previous environment relationship (${currentEnvRel.data.id})...`);
      await reactor.removeEnvironmentRelationshipFromLibrary(libraryId, currentEnvRel.data.id);
    }

    // Assign the staging environment to this library.
    await reactor.setEnvironmentRelationshipForLibrary(libraryId, environmentId);

    const stagingBuild = await createBuildAndPoll(reactor, libraryId);
    console.log(`  Staging build succeeded: ${stagingBuild.id}`);

    // Library stays in "submitted" state. The approve step happens during
    // the prod sync, after QA has been done in staging.
    console.log('✅ Published to staging environment.');
    console.log('   Library is in "submitted" state. Do QA in staging, then sync the prod branch to approve and publish to production.');

  // ─────────────────────────────────────────────────────────────────────────
  // PRODUCTION
  // Find the latest git-sync-* library in "submitted" state (left there by
  // the staging sync after QA), approve it, assign the production environment,
  // and trigger the final build.
  // Only libraries that went through a staging build are allowed — libraries
  // manually submitted from "development" without a staging build are rejected.
  // ─────────────────────────────────────────────────────────────────────────
  } else if (envStage === 'production') {
    const library = await findGitSyncLibrary(reactor, propertyId, 'submitted');
    if (!library) {
      console.warn(
        '\n⚠️  Cannot promote to production: no git-sync-* library found in "submitted" state.\n' +
        '   You must publish to staging first (sync on the staging branch) before promoting to production.\n'
      );
      return;
    }
    const libraryId = library.id;
    console.log(`  Promoting library ${libraryId} ("${library.attributes.name}") to production...`);

    // Verify this library actually went through a staging build.
    // A library manually submitted from "development" (via UI or otherwise)
    // without a staging build must not be allowed to reach production.
    const builds = (await reactor.listBuildsForLibrary(libraryId)).data;
    const hasStagingBuild = await (async () => {
      for (const build of builds) {
        if (!build.relationships || !build.relationships.environment || !build.relationships.environment.data) continue;
        const buildEnv = (await reactor.getEnvironment(build.relationships.environment.data.id)).data;
        if (buildEnv.attributes.stage === 'staging') return true;
      }
      return false;
    })();

    if (!hasStagingBuild) {
      console.warn(
        `\n⚠️  Cannot promote to production: library "${library.attributes.name}" (${libraryId}) has not been built for a staging environment.\n` +
        '   Only libraries that went through staging can be promoted to production.\n' +
        '   Run sync on the staging branch first to build and validate in staging.\n'
      );
      return;
    }
    console.log(`  Staging build confirmed for library ${libraryId}.`);

    // Approve the library — this is the QA sign-off step, done here after
    // the team has validated the build in staging.
    await reactor.transitionLibrary(libraryId, 'approve');
    console.log(`  Library approved.`);

    // Remove any previously assigned environment (e.g. the staging environment)
    // before assigning the production one.
    const currentEnvRel = await reactor.getEnvironmentRelationshipForLibrary(libraryId);
    if (currentEnvRel && currentEnvRel.data && currentEnvRel.data.id !== environmentId) {
      console.log(`  Removing previous environment relationship (${currentEnvRel.data.id})...`);
      await reactor.removeEnvironmentRelationshipFromLibrary(libraryId, currentEnvRel.data.id);
    }

    // Assign the production environment to this library.
    await reactor.setEnvironmentRelationshipForLibrary(libraryId, environmentId);

    const prodBuild = await createBuildAndPoll(reactor, libraryId);
    console.log(`  Production build succeeded: ${prodBuild.id}`);
    console.log('✅ Published to production environment.');

  } else {
    throw new Error(`Unknown environment stage: "${envStage}". Expected development, staging, or production.`);
  }
};
