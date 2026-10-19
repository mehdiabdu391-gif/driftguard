import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStainlessApiMd, parseOctokitEndpoints, parseStripeNodeResource, parseStripeNodeIndex, parsePythonClasses } from '../src/sdkmaps/build.js';

// Source excerpts are copied from the SDKs' public repositories.

test('Stainless api.md (openai-node and openai-python formats)', () => {
  const md = [
    '- <code title="post /chat/completions">client.chat.completions.<a href="./src/resources/chat/completions/completions.ts">create</a>({ ...params }) -> ChatCompletion</code>',
    '- <code title="get /chat/completions/{completion_id}">client.chat.completions.<a href="./src/openai/resources/chat/completions/completions.py">retrieve</a>(completion_id) -> ChatCompletion</code>',
  ].join('\n');
  assert.deepEqual(parseStainlessApiMd(md, 'api.md'), {
    'chat.completions.create': { method: 'POST', path: '/chat/completions', source: 'api.md' },
    'chat.completions.retrieve': { method: 'GET', path: '/chat/completions/{completion_id}', source: 'api.md' },
  });
});

test('octokit endpoint table, single- and multi-line entries', async () => {
  const src = `const Endpoints: EndpointsDefaultsAndDecorations = {
  actions: {
    approveWorkflowRun: [
      "POST /repos/{owner}/{repo}/actions/runs/{run_id}/approve",
    ],
    createHostedRunnerForOrg: ["POST /orgs/{org}/actions/hosted-runners"],
  },
  repos: { get: ["GET /repos/{owner}/{repo}", {}, { renamed: ["x", "y"] }] },
};`;
  const m = await parseOctokitEndpoints(src, 'endpoints.ts');
  assert.equal(m['actions.approveWorkflowRun'].path, '/repos/{owner}/{repo}/actions/runs/{run_id}/approve');
  assert.equal(m['actions.createHostedRunnerForOrg'].method, 'POST');
  assert.equal(m['repos.get'].path, '/repos/{owner}/{repo}');
});

test('stripe-node resource: template paths and branching methods', async () => {
  const src = `export class AccountResource extends StripeResource {
  retrieve(id: string | null, params?: P, options?: RequestOptions): Promise<Response<Account>> {
    if (typeof id === 'string') {
      return this._makeRequest('GET', \`/v1/accounts/\${encodeURIComponent(id)}\`, params, options) as any;
    } else {
      return this._makeRequest('GET', '/v1/account', params, options) as any;
    }
  }
  create(params?: P, options?: RequestOptions) {
    return this._makeRequest('POST', '/v1/accounts', params, options) as any;
  }
}`;
  const m = await parseStripeNodeResource(src);
  assert.deepEqual(m.create, { method: 'POST', path: '/v1/accounts' });
  assert.equal(m.retrieve.alternatives?.length, 2);
});

test('stripe-node resources.ts wiring', async () => {
  const src = `import {resourceNamespace} from './ResourceNamespace.js';
import {AlertResource as BillingAlerts} from './resources/Billing/Alerts.js';
import {AccountResource as V2CoreAccounts} from './resources/V2/Core/Accounts.js';
export {CustomerResource as Customers} from './resources/Customers.js';
export {OAuthResource} from './resources/OAuth.js';
export const Billing = resourceNamespace('billing', { Alerts: BillingAlerts });
export const V2 = resourceNamespace('v2', { Core: resourceNamespace('core', { Accounts: V2CoreAccounts }) });`;
  const idx = await parseStripeNodeIndex(src);
  assert.deepEqual(idx, [
    { prefix: 'customers', file: './resources/Customers.js' },
    { prefix: 'oauth', file: './resources/OAuth.js' },
    { prefix: 'billing.alerts', file: './resources/Billing/Alerts.js' },
    { prefix: 'v2.core.accounts', file: './resources/V2/Core/Accounts.js' },
  ]);
});

test('stripe-python legacy class: literal, format, class_url and retrieve-by-refresh', async () => {
  const src = `class Customer(CreateableAPIResource["Customer"]):
    OBJECT_NAME: ClassVar[Literal["customer"]] = "customer"

    @classmethod
    def create(cls, **params):
        return cast("Customer", cls._static_request("post", cls.class_url(), params=params))

    @classmethod
    def modify(cls, id, **params):
        url = "%s/%s" % (cls.class_url(), sanitize_id(id))
        return cast("Customer", cls._static_request("post", url, params=params))

    @classmethod
    def _cls_delete_discount(cls, customer, **params):
        return cls._static_request("delete", "/v1/customers/{customer}/discount".format(customer=sanitize_id(customer)), params=params)

    @classmethod
    def retrieve(cls, id, **params):
        instance = cls(id, **params)
        instance.refresh()
        return instance
`;
  const [cls] = await parsePythonClasses(src);
  assert.equal(cls.objectName, 'customer');
  assert.deepEqual(cls.methods.create, { method: 'POST', path: '/v1/customers' });
  assert.deepEqual(cls.methods.modify, { method: 'POST', path: '/v1/customers/{}' });
  assert.deepEqual(cls.methods.delete_discount, { method: 'DELETE', path: '/v1/customers/{customer}/discount' });
  assert.deepEqual(cls.methods.retrieve, { method: 'GET', path: '/v1/customers/{}' });
});

test('stripe-python: no derived URL when the class overrides instance_url', async () => {
  const src = `class Account(APIResource):
    OBJECT_NAME = "account"

    @classmethod
    def retrieve(cls, id=None, **params):
        instance = cls(id, **params)
        instance.refresh()
        return instance

    def instance_url(self):
        return self._build_instance_url(self._data.get("id"))
`;
  const [cls] = await parsePythonClasses(src);
  assert.equal(cls.methods.retrieve, undefined);
});
