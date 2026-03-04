// Returns the buildId of the most recent succeeded build for a given environment.
// The Reactor SDK does not expose listBuildsForEnvironment, so we use the
// low-level reactor.get() method to call the API endpoint directly.
// Returns null if no succeeded build exists yet (e.g. environment was never built).
async function getEnvironmentBuildId(reactor, environmentId) {
  const response = await reactor.get(`/environments/${environmentId}/builds`, {
    'filter[status]': 'succeeded',
    'sort': '-created_at',
    'page[size]': 1
  });
  return (response.data && response.data[0]) ? response.data[0].id : null;
}

module.exports = getEnvironmentBuildId;
