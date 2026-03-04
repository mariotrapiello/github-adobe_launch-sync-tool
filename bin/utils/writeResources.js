const toFiles = require('./toFiles');
const toMethodName = require('./resourceName');
const ruleComponentsName = 'rule_components';
const pages = { 'page[size]': 999 };

function formArgs(resourceType, args) {
  const base = args.baseDir || '.';
  return {
    propertyId: args.propertyId,
    baseDir: args.baseDir,
    reactor: args.reactor,
    propertyPath: `${base}/${args.propertyId}`,
    dataElementsPath: `${base}/${args.propertyId}/${resourceType}`
  };
}

function writeRemaining(data, resourceType, settings) {
  if (data.constructor.name == 'Array') {
    data.forEach( resource => toFiles(resource, formArgs(resourceType, settings)));
  } else { toFiles(data, formArgs(resourceType, settings)); }
}

function writeRuleComponent(resourceTypes, resourceType, adobeResources, settings) {
  for (let rule of adobeResources) {
    settings.reactor.listRuleComponentsForRule(rule.id, pages)
    .then(({ data: adobeRuleComponents }) => {
      writeRemaining(adobeRuleComponents, resourceType, settings);
    });
  }
}

function writeRuleComponentOr(resourceTypes, resourceType, adobeResources, settings) {
  if (resourceType === 'rules' && resourceTypes.includes(ruleComponentsName))
    writeRuleComponent(resourceTypes, resourceType, adobeResources, settings);
}

// Returns the promise that fetches remote resources for a given type.
// In environment mode (settings.buildId present) uses build-scoped endpoints;
// otherwise falls back to property-scoped endpoints (draft mode).
function fetchResources(settings, resourceName, resourceType) {
  const reactor = settings.reactor;
  const buildId = settings.buildId;

  if (buildId) {
    if (resourceType === 'data_elements') {
      return reactor.getDataElementsForBuild(buildId).then(r => r.data);
    }
    if (resourceType === 'rules') {
      return reactor.listRulesForBuild(buildId, pages).then(r => r.data);
    }
    if (resourceType === 'extensions') {
      return reactor.listExtensionsForBuild(buildId, pages).then(r => r.data);
    }
  }

  // Draft mode fallback
  const methodName = resourceName === 'Property' ? 'getProperty' : `list${resourceName}ForProperty`;
  return reactor[methodName](settings.propertyId, pages).then(r => r.data);
}

function listResources(settings, resourceName, resourceType, resourceTypes) {
  fetchResources(settings, resourceName, resourceType)
    .then((adobeResources) =>
      writeAll(resourceTypes, resourceType, adobeResources, settings)
    );
}

function writeAll(resourceTypes, resourceType, adobeResources, settings) {
  writeRuleComponentOr(resourceTypes, resourceType, adobeResources, settings);
  writeRemaining(adobeResources, resourceType, settings);
}

function writeResources(resourceTypes, settings) {
  resourceTypes.forEach( (resourceType, index, resourceTypes) => {
    if (resourceType === ruleComponentsName) return;
    const resourceName = toMethodName(resourceType, false);
      
    try {
      return listResources(settings, resourceName, resourceType, resourceTypes);
    } catch (error) {
      console.error('🚨Error in writeResources(): ', error);
    }
  });
}

module.exports = writeResources;