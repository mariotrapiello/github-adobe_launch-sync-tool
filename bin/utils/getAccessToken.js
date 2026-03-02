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

// Patched: replaced Service Account (JWT) auth (EOL March 1 2026) with
// OAuth 2.0 Server-to-Server (client_credentials grant).
// No private key needed — only clientId and clientSecret from Adobe Developer Console.

const request = require('request-promise-native');

const DEFAULT_SCOPES = [
  'openid',
  'AdobeID',
  'read_organizations',
  'reactor_manage_properties',
  'reactor_manage_environments',
  'reactor_manage_extensions',
  'reactor_manage_rules',
  'reactor_manage_data_elements',
  'reactor_manage_builds',
  'reactor_manage_hosts',
  'reactor_develop'
].join(',');

async function getAccessToken(settings) {
  const integration = settings.integration;

  if (!integration) {
    throw new Error('settings file does not have an "integration" property.');
  }
  if (!integration.clientId) {
    throw new Error('settings file does not have an "integration.clientId" property.');
  }
  if (!integration.clientSecret) {
    throw new Error('settings file does not have an "integration.clientSecret" property.');
  }

  const scopes = integration.scopes || DEFAULT_SCOPES;

  try {
    const body = await request({
      method: 'POST',
      url: 'https://ims-na1.adobelogin.com/ims/token/v3',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cache-Control': 'no-cache'
      },
      form: {
        client_id: integration.clientId,
        client_secret: integration.clientSecret,
        grant_type: 'client_credentials',
        scope: scopes
      },
      transform: JSON.parse
    });

    return body.access_token;

  } catch (e) {
    let message = e.message;
    try {
      const parsed = JSON.parse(e.error);
      message = parsed.error_description || parsed.error || message;
    } catch (_) {}
    throw new Error(
      `Error retrieving access token (OAuth 2.0): ${message}. ` +
      'Check that clientId, clientSecret and scopes in your .reactor-settings.json are correct.'
    );
  }
}

async function checkAccessToken(args) {
  if (!args.accessToken)
    return await getAccessToken(args);
}

module.exports = checkAccessToken;
