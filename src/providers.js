// Registry of tracked API specifications and the official SDKs mapped onto them.
// Every entry points at a public, provider-maintained source. Nothing here is inferred.

/**
 * @typedef {object} SpecSource
 * @property {string} id            Stable identifier used in data file names.
 * @property {string} provider      Provider key shared by specs and SDKs.
 * @property {string} name          Human-readable name.
 * @property {string} repo          GitHub "owner/name" of the provider's spec repository.
 * @property {string} branch        Branch the provider publishes to.
 * @property {string} file          Path of the OpenAPI JSON document inside the repository.
 * @property {{host: string, pathPrefix: string}[]} hosts
 *   Hosts the API is served from. `pathPrefix` is the part of the URL path that the
 *   spec's server URL already contains (it is stripped before matching spec paths).
 * @property {string} [note]        Caveat shown next to every finding for this spec.
 */

/** @type {SpecSource[]} */
export const SPECS = [
  {
    id: 'stripe',
    provider: 'stripe',
    name: 'Stripe API',
    repo: 'stripe/openapi',
    branch: 'master',
    file: 'latest/openapi.spec3.json',
    hosts: [
      { host: 'api.stripe.com', pathPrefix: '' },
      { host: 'files.stripe.com', pathPrefix: '' },
    ],
    note:
      'Stripe pins an API version per account or per request. A Stripe spec change reaches your code when your API version moves forward, which for stripe-node and stripe-python usually happens when you upgrade the SDK.',
  },
  {
    id: 'openai',
    provider: 'openai',
    name: 'OpenAI API',
    repo: 'openai/openai-openapi',
    branch: 'main',
    file: 'openapi.json',
    hosts: [{ host: 'api.openai.com', pathPrefix: '/v1' }],
  },
  {
    id: 'github',
    provider: 'github',
    name: 'GitHub REST API (version 2022-11-28)',
    repo: 'github/rest-api-description',
    branch: 'main',
    file: 'descriptions/api.github.com/api.github.com.2022-11-28.json',
    hosts: [{ host: 'api.github.com', pathPrefix: '' }],
    note: 'Tracks the 2022-11-28 REST API version description published by GitHub.',
  },
  {
    id: 'twilio-api',
    provider: 'twilio',
    name: 'Twilio REST API (2010-04-01)',
    repo: 'twilio/twilio-oai',
    branch: 'main',
    file: 'spec/json/twilio_api_v2010.json',
    hosts: [{ host: 'api.twilio.com', pathPrefix: '' }],
  },
  {
    id: 'twilio-verify',
    provider: 'twilio',
    name: 'Twilio Verify API',
    repo: 'twilio/twilio-oai',
    branch: 'main',
    file: 'spec/json/twilio_verify_v2.json',
    hosts: [{ host: 'verify.twilio.com', pathPrefix: '' }],
  },
];

/**
 * Official SDKs. `module` names are what user code imports.
 * `mapped` says whether DriftGuard has a method-to-endpoint map built from the SDK's own source.
 * @type {{id: string, provider: string, specId: string|null, language: 'js'|'python', modules: string[], repo: string, mapped: boolean}[]}
 */
export const SDKS = [
  { id: 'stripe-node', provider: 'stripe', specId: 'stripe', language: 'js', modules: ['stripe'], repo: 'stripe/stripe-node', mapped: true },
  { id: 'stripe-python', provider: 'stripe', specId: 'stripe', language: 'python', modules: ['stripe'], repo: 'stripe/stripe-python', mapped: true },
  { id: 'openai-node', provider: 'openai', specId: 'openai', language: 'js', modules: ['openai'], repo: 'openai/openai-node', mapped: true },
  { id: 'openai-python', provider: 'openai', specId: 'openai', language: 'python', modules: ['openai'], repo: 'openai/openai-python', mapped: true },
  {
    id: 'octokit',
    provider: 'github',
    specId: 'github',
    language: 'js',
    modules: ['@octokit/rest', 'octokit', '@octokit/core', '@octokit/action', '@actions/github'],
    repo: 'octokit/plugin-rest-endpoint-methods.js',
    mapped: true,
  },
  { id: 'twilio-node', provider: 'twilio', specId: null, language: 'js', modules: ['twilio'], repo: 'twilio/twilio-node', mapped: false },
  { id: 'twilio-python', provider: 'twilio', specId: null, language: 'python', modules: ['twilio', 'twilio.rest'], repo: 'twilio/twilio-python', mapped: false },
];

/** @param {string} id */
export function specById(id) {
  const spec = SPECS.find((s) => s.id === id);
  if (!spec) throw new Error(`Unknown spec id: ${id}`);
  return spec;
}

/**
 * Find the spec served from a URL host.
 * @param {string} host
 */
export function specForHost(host) {
  const h = host.toLowerCase();
  for (const spec of SPECS) {
    const entry = spec.hosts.find((x) => x.host === h);
    if (entry) return { spec, pathPrefix: entry.pathPrefix };
  }
  return null;
}

/** Windows (in days) for which the tracker publishes net changes. */
export const WINDOWS = [30, 90, 180];
