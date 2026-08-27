import assert from 'node:assert/strict';
import test from 'node:test';

// Avoid invoking the CLI entrypoint while importing the built bundle.
process.env.IGNITE_PLUGIN_BUILD = 'true';
const { default: plugin, FactoryDeploymentTypePlugin } = await import('../dist/index.js');

const ADDRESS = '0x00000000000000000000000000000000000000aa';

// One ABI that exercises every discovery rule at once: mutability filtering,
// overloads, tuple inputs, unnamed outputs, and interleaved non-address
// outputs.
const FACTORY_ABI = [
  { type: 'constructor', inputs: [] },
  { type: 'event', name: 'Deployed', inputs: [] },
  {
    type: 'function',
    name: 'implementation',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'compute',
    stateMutability: 'pure',
    inputs: [{ name: 'salt', type: 'bytes32' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'configure',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'fee', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'deploy',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'salt', type: 'bytes32' }],
    outputs: [{ name: 'jar', type: 'address' }],
  },
  {
    type: 'function',
    name: 'deploy',
    stateMutability: 'payable',
    inputs: [
      { name: 'salt', type: 'bytes32' },
      {
        name: 'config',
        type: 'tuple',
        components: [
          { name: 'owner', type: 'address' },
          { name: 'fee', type: 'uint256' },
        ],
      },
    ],
    outputs: [
      { name: 'jar', type: 'address' },
      { name: 'nonce', type: 'uint256' },
      { name: '', type: 'address' },
    ],
  },
];

const source = (contractName, abi) => ({ selectionId: `sel-${contractName}`, contractName, abi });

// The host's bounded-input contract, mirrored from core's DeploymentTypeService
// parseCompose/parseComposerField. Core rejects a violating response WHOLE — a
// generic 400 that discards the usable candidates too — so every response this
// suite produces is checked against the caps, not just the ones under test.
const KEY = /^[a-zA-Z][a-zA-Z0-9._-]*$/;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const bounded = (value, min, max, what) => {
  assert.equal(typeof value, 'string', `${what} must be a string`);
  assert.ok(value.length >= min && value.length <= max, `${what} length ${value.length} outside ${min}..${max}`);
};
const hostKey = (value, what) => {
  bounded(value, 1, 64, what);
  assert.ok(KEY.test(value), `${what} '${value}' fails the host key regex`);
};

function assertHostAcceptable(data) {
  assert.ok(Array.isArray(data.fields) && data.fields.length <= 32, `field count ${data.fields?.length}`);
  const keys = data.fields.map((field) => field.key);
  assert.equal(new Set(keys).size, keys.length, 'duplicate field keys');
  for (const field of data.fields) {
    hostKey(field.key, `field key ${field.key}`);
    bounded(field.label, 1, 280, `label of ${field.key}`);
    if (field.description !== undefined) bounded(field.description, 1, 280, `description of ${field.key}`);
    if (field.type !== 'select') continue;
    assert.ok(field.options.length >= 1 && field.options.length <= 64, `option count ${field.options.length}`);
    for (const option of field.options) {
      bounded(option.value, 1, 280, `option value of ${field.key}`);
      assert.ok(!CONTROL.test(option.value), 'option value carries a control character');
      bounded(option.label, 1, 280, `option label of ${field.key}`);
    }
    const values = field.options.map((option) => option.value);
    assert.equal(new Set(values).size, values.length, 'duplicate select option values');
  }
  if (data.blocker !== undefined) bounded(data.blocker, 1, 500, 'blocker');
  if (data.composition === undefined) return;
  assert.equal(data.blocker, undefined, 'a composition may not accompany a blocker');
  const products = data.composition.products;
  assert.ok(products.length >= 1 && products.length <= 16, `product count ${products.length}`);
  for (const product of products) {
    hostKey(product.key, `product key ${product.key}`);
    hostKey(product.artifactField, `product artifact field ${product.artifactField}`);
    assert.ok(Number.isInteger(product.outputIndex) && product.outputIndex >= 0, 'product output index');
  }
  assert.equal(new Set(products.map((product) => product.key)).size, products.length, 'duplicate product keys');
  assert.equal(
    new Set(products.map((product) => product.outputIndex)).size,
    products.length,
    'duplicate product output indexes',
  );
}

async function compose(values = {}, artifacts = {}) {
  const response = await plugin.composeDeployment({ compositionId: 'test', values, artifacts });
  assert.equal(response.success, true, JSON.stringify(response));
  assertHostAcceptable(response.data);
  return response.data;
}

const functionField = (data) => data.fields.find((field) => field.key === 'function');
const productFields = (data) => data.fields.filter((field) => field.key.startsWith('product.'));

test('metadata and descriptor carry the call-products identity', async () => {
  const info = FactoryDeploymentTypePlugin.getInfo();
  assert.equal(info.success, true);
  assert.equal(info.data.id, 'factory');
  assert.deepEqual(info.data.types, ['deployment-type']);
  assert.deepEqual(info.data.operations, ['describeDeploymentType', 'composeDeployment']);
  assert.deepEqual(info.data.permissions, []);
  assert.deepEqual(info.data.configFields, []);
  assert.equal(info.data.baseImage, 'ignite/deployment-type_factory:latest');

  const describe = await plugin.describeDeploymentType();
  assert.equal(describe.success, true);
  assert.equal(describe.data.label, 'Factory');
  assert.equal(describe.data.execution, 'call-products');
  assert.deepEqual(describe.data.params, []);
});

test('progression: no artifact yields only the base fields', async () => {
  const data = await compose();
  assert.deepEqual(
    data.fields.map((field) => [field.type, field.key]),
    [
      ['artifact', 'factory'],
      ['address', 'address'],
    ],
  );
  assert.deepEqual(data.fields[0].origins, ['repo']);
  assert.equal(data.blocker, undefined);
  assert.equal(data.composition, undefined);
});

test('discovery filters by state mutability and address outputs', async () => {
  const data = await compose({}, { factory: source('Factory', FACTORY_ABI) });
  const field = functionField(data);
  assert.equal(field.type, 'select');
  assert.equal(field.required, true);
  // view/pure and address-less functions never become producer options.
  assert.deepEqual(
    field.options.map((option) => option.value),
    ['deploy(bytes32)', 'deploy(bytes32,(address,uint256))'],
  );
  // No function selected yet: no product fields, no composition.
  assert.deepEqual(productFields(data), []);
  assert.equal(data.composition, undefined);
});

test('overloads stay distinct through canonical values with tuple expansion', async () => {
  const data = await compose({}, { factory: source('Factory', FACTORY_ABI) });
  const values = functionField(data).options.map((option) => option.value);
  assert.equal(new Set(values).size, values.length);
  assert.ok(values.includes('deploy(bytes32,(address,uint256))'));
});

test('option labels keep parameter names and list the product keys', async () => {
  const data = await compose({}, { factory: source('Factory', FACTORY_ABI) });
  const labels = functionField(data).options.map((option) => option.label);
  assert.deepEqual(labels, [
    'deploy(bytes32 salt) → deploys jar',
    'deploy(bytes32 salt, (address owner, uint256 fee) config) → deploys jar, output2',
  ]);
});

test('legacy constant flag substitutes for a missing stateMutability', async () => {
  const abi = [
    { type: 'function', name: 'peek', constant: true, inputs: [], outputs: [{ name: '', type: 'address' }] },
    { type: 'function', name: 'spawn', inputs: [], outputs: [{ name: 'child', type: 'address' }] },
  ];
  const data = await compose({}, { factory: source('Legacy', abi) });
  assert.deepEqual(
    functionField(data).options.map((option) => option.value),
    ['spawn()'],
  );
});

test('selecting a function adds one required artifact field per address output', async () => {
  const data = await compose(
    { function: 'deploy(bytes32,(address,uint256))' },
    { factory: source('Factory', FACTORY_ABI) },
  );
  // Unnamed outputs get stable output<index> keys, and the index counts
  // across ALL outputs, so the interleaved uint256 keeps its position.
  assert.deepEqual(
    productFields(data).map((field) => [field.type, field.key, field.required]),
    [
      ['artifact', 'product.jar', true],
      ['artifact', 'product.output2', true],
    ],
  );
  assert.equal(data.composition, undefined);
});

test('partial product mapping withholds the composition', async () => {
  const data = await compose(
    { address: ADDRESS, function: 'deploy(bytes32,(address,uint256))' },
    {
      factory: source('Factory', FACTORY_ABI),
      'product.jar': source('Jar', []),
    },
  );
  assert.equal(data.blocker, undefined);
  assert.equal(data.composition, undefined);
});

test('a malformed address value withholds the composition', async () => {
  const data = await compose(
    { address: 'not-an-address', function: 'deploy(bytes32)' },
    {
      factory: source('Factory', FACTORY_ABI),
      'product.jar': source('Jar', []),
    },
  );
  assert.equal(data.composition, undefined);
});

test('complete mapping returns the producer and every product', async () => {
  const data = await compose(
    { address: ADDRESS, function: 'deploy(bytes32,(address,uint256))' },
    {
      factory: source('Factory', FACTORY_ABI),
      'product.jar': source('Jar', []),
      'product.output2': source('Releaser', []),
    },
  );
  assert.equal(data.blocker, undefined);
  assert.deepEqual(data.composition, {
    producer: { abiArtifactField: 'factory', targetField: 'address', functionField: 'function' },
    products: [
      { key: 'jar', artifactField: 'product.jar', outputIndex: 0 },
      { key: 'output2', artifactField: 'product.output2', outputIndex: 2 },
    ],
  });
});

test('single-product overload composes with output index 0', async () => {
  const data = await compose(
    { address: ADDRESS, function: 'deploy(bytes32)' },
    {
      factory: source('Factory', FACTORY_ABI),
      'product.jar': source('Jar', []),
    },
  );
  assert.deepEqual(data.composition.products, [
    { key: 'jar', artifactField: 'product.jar', outputIndex: 0 },
  ]);
});

test('malformed ABIs blocker instead of throwing', async () => {
  const malformed = [
    'not an array at all',
    [42],
    [{ type: 'function', name: 7 }],
    [{ type: 'function', name: 'x', inputs: [{ type: 5 }], outputs: [{ name: '', type: 'address' }] }],
    // A tuple without components cannot expand to a canonical signature.
    [{ type: 'function', name: 'x', stateMutability: 'nonpayable', inputs: [{ name: 'a', type: 'tuple' }], outputs: [{ name: '', type: 'address' }] }],
  ];
  for (const abi of malformed) {
    const data = await compose({}, { factory: source('Broken', abi) });
    assert.equal(typeof data.blocker, 'string', JSON.stringify(abi));
    assert.equal(data.composition, undefined);
    assert.deepEqual(productFields(data), []);
  }
});

test('an ABI without any qualifying function blockers honestly', async () => {
  const abi = [
    { type: 'function', name: 'peek', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  ];
  const data = await compose({}, { factory: source('Viewer', abi) });
  assert.equal(typeof data.blocker, 'string');
  assert.equal(functionField(data), undefined);
});

test('a vanished or unknown selection blockers instead of composing', async () => {
  const data = await compose(
    { address: ADDRESS, function: 'deploy(uint8)' },
    { factory: source('Factory', FACTORY_ABI) },
  );
  assert.equal(typeof data.blocker, 'string');
  assert.equal(data.composition, undefined);
});

test('duplicate output names blocker rather than emit colliding field keys', async () => {
  const abi = [
    {
      type: 'function',
      name: 'twin',
      stateMutability: 'nonpayable',
      inputs: [],
      outputs: [
        { name: 'child', type: 'address' },
        { name: 'child', type: 'address' },
      ],
    },
  ];
  const data = await compose({ function: 'twin()' }, { factory: source('Twins', abi) });
  assert.equal(typeof data.blocker, 'string');
  assert.deepEqual(productFields(data), []);
});

// --- host caps: nothing an ABI can contain may make core reject the response ---

const fn = (name, inputs, outputs) => ({
  type: 'function',
  name,
  stateMutability: 'nonpayable',
  inputs,
  outputs,
});
const addressOutputs = (count, name = (index) => `child${index}`) =>
  Array.from({ length: count }, (_, index) => ({ name: name(index), type: 'address' }));
// A realistic config-struct factory: 40 tuple components push the canonical
// signature past the host's 280-char select-value cap.
const CONFIG_STRUCT_FACTORY = fn(
  'createManagedLiquidityPool',
  [
    {
      name: 'config',
      type: 'tuple',
      components: Array.from({ length: 40 }, (_, index) => ({ name: `poolParameter${index}`, type: 'uint256' })),
    },
  ],
  [{ name: 'pool', type: 'address' }],
);
const CLONE = fn('clone', [], [{ name: 'copy', type: 'address' }]);

test('an over-long signature is omitted while its siblings stay reachable', async () => {
  const data = await compose({}, { factory: source('Pools', [CONFIG_STRUCT_FACTORY, CLONE]) });
  const field = functionField(data);
  // The unrepresentable candidate is the one dropped — clone() must survive,
  // because core would otherwise discard the whole response as a generic 400.
  assert.deepEqual(field.options.map((option) => option.value), ['clone()']);
  // The omission is named, not silent.
  assert.match(field.description, /createManagedLiquidityPool/);
  assert.match(field.description, /280/);
});

test('selecting an omitted over-long signature blockers with the real reason', async () => {
  const data = await compose(
    { address: ADDRESS, function: `createManagedLiquidityPool((${'uint256,'.repeat(39)}uint256))` },
    { factory: source('Pools', [CONFIG_STRUCT_FACTORY, CLONE]) },
  );
  assert.match(data.blocker, /cannot be offered because/);
  assert.match(data.blocker, /characters/);
  assert.equal(data.composition, undefined);
});

test('an ABI whose only function is unrepresentable blockers honestly', async () => {
  const data = await compose({}, { factory: source('Pools', [CONFIG_STRUCT_FACTORY]) });
  assert.match(data.blocker, /no usable factory function/);
  // No select field may be emitted with an empty option list.
  assert.equal(functionField(data), undefined);
});

test('an over-long label is shortened but keeps its candidate selectable', async () => {
  // Named parameters make the label overflow long before the value does.
  const wide = fn(
    'deployWide',
    [
      {
        name: 'config',
        type: 'tuple',
        components: Array.from({ length: 10 }, (_, index) => ({
          name: `aVeryDescriptiveParameterName${index}`,
          type: 'uint256',
        })),
      },
    ],
    [{ name: 'jar', type: 'address' }],
  );
  const data = await compose({}, { factory: source('Wide', [wide]) });
  const [option] = functionField(data).options;
  assert.equal(option.value, `deployWide((${'uint256,'.repeat(9)}uint256))`);
  assert.equal(option.label.length, 280);
  // A visible ellipsis, so the shortening never reads as the real signature.
  assert.ok(option.label.endsWith('…'));
  assert.ok(option.label.startsWith('deployWide((uint256 aVeryDescriptiveParameterName0'));
  // Still fully usable: the value identifies the function.
  const composed = await compose(
    { address: ADDRESS, function: option.value },
    { factory: source('Wide', [wide]), 'product.jar': source('Jar', []) },
  );
  assert.deepEqual(composed.composition.products, [
    { key: 'jar', artifactField: 'product.jar', outputIndex: 0 },
  ]);
});

test('output names the host cannot key fall back to their output position', async () => {
  // `$` and a leading `_` are legal Solidity identifiers but illegal keys, and
  // `product.` + 57 chars overflows the 64-char key cap while 56 still fits.
  const tooLong = 'x'.repeat(57);
  const longest = 'y'.repeat(56);
  const abi = [
    fn('spawn', [], [
      { name: '$jar', type: 'address' },
      { name: '_releaser', type: 'address' },
      { name: tooLong, type: 'address' },
      { name: longest, type: 'address' },
      { name: 'ok', type: 'address' },
    ]),
  ];
  const data = await compose({ function: 'spawn()' }, { factory: source('Dollars', abi) });
  assert.equal(data.blocker, undefined);
  assert.deepEqual(
    productFields(data).map((field) => field.key),
    ['product.output0', 'product.output1', 'product.output2', `product.${longest}`, 'product.ok'],
  );
  // The rename is explained on the field it affects, and only there.
  assert.match(productFields(data)[0].description, /\$jar/);
  assert.equal(productFields(data)[4].description, undefined);

  const composed = await compose(
    { address: ADDRESS, function: 'spawn()' },
    {
      factory: source('Dollars', abi),
      'product.output0': source('A', []),
      'product.output1': source('B', []),
      'product.output2': source('C', []),
      [`product.${longest}`]: source('D', []),
      'product.ok': source('E', []),
    },
  );
  // Positional fallback keys stay mapped to their own output index.
  assert.deepEqual(composed.composition.products, [
    { key: 'output0', artifactField: 'product.output0', outputIndex: 0 },
    { key: 'output1', artifactField: 'product.output1', outputIndex: 1 },
    { key: 'output2', artifactField: 'product.output2', outputIndex: 2 },
    { key: longest, artifactField: `product.${longest}`, outputIndex: 3 },
    { key: 'ok', artifactField: 'product.ok', outputIndex: 4 },
  ]);
});

test('a fallback key that collides with a real output name blockers', async () => {
  // Truncating or renaming into an existing key would mis-map an output, so
  // the collision is refused instead.
  const abi = [
    fn('twin', [], [
      { name: 'output1', type: 'address' },
      { name: '$x', type: 'address' },
    ]),
  ];
  const data = await compose({ function: 'twin()' }, { factory: source('Collide', abi) });
  assert.match(data.blocker, /duplicate product keys/);
  assert.deepEqual(productFields(data), []);
});

test('a function returning more than 16 addresses is never offered', async () => {
  const abi = [fn('deployAll', [], addressOutputs(17)), CLONE];
  const data = await compose({}, { factory: source('All', abi) });
  assert.deepEqual(functionField(data).options.map((option) => option.value), ['clone()']);
  assert.match(functionField(data).description, /deployAll\(\)/);
  assert.match(functionField(data).description, /16 products/);
  // And it dead-ends immediately rather than after the user maps 17 products.
  const selected = await compose(
    { address: ADDRESS, function: 'deployAll()' },
    { factory: source('All', abi) },
  );
  assert.match(selected.blocker, /17 addresses/);
  assert.deepEqual(productFields(selected), []);
});

test('a function returning more addresses than the field cap is never offered', async () => {
  // 30 address outputs would need 33 fields; the 16-product cap catches it
  // first, so no response can exceed the host's 32-field limit.
  const abi = [fn('deployMany', [], addressOutputs(30))];
  const data = await compose({ address: ADDRESS, function: 'deployMany()' }, { factory: source('Many', abi) });
  assert.match(data.blocker, /30 addresses/);
  assert.ok(data.fields.length <= 32);
  assert.deepEqual(productFields(data), []);
});

test('exactly 16 address outputs still compose', async () => {
  const abi = [fn('deploySixteen', [], addressOutputs(16))];
  const artifacts = { factory: source('Sixteen', abi) };
  for (let index = 0; index < 16; index += 1) artifacts[`product.child${index}`] = source(`C${index}`, []);
  const data = await compose({ address: ADDRESS, function: 'deploySixteen()' }, artifacts);
  assert.equal(data.blocker, undefined);
  assert.equal(data.composition.products.length, 16);
  assert.deepEqual(
    data.composition.products.map((product) => product.outputIndex),
    Array.from({ length: 16 }, (_, index) => index),
  );
});

test('more than 64 candidates are capped at the option limit', async () => {
  const abi = Array.from({ length: 70 }, (_, index) =>
    fn(`deploy${index}`, [], [{ name: 'jar', type: 'address' }]),
  );
  const data = await compose({}, { factory: source('Crowd', abi) });
  const field = functionField(data);
  assert.equal(field.options.length, 64);
  // The first 64 in ABI order are offered, deterministically.
  assert.equal(field.options[0].value, 'deploy0()');
  assert.equal(field.options[63].value, 'deploy63()');
  assert.match(field.description, /6 functions cannot be offered/);
  // A selection beyond the cap is not silently composed: core would reject a
  // value that is not a declared option.
  const beyond = await compose(
    { address: ADDRESS, function: 'deploy64()' },
    { factory: source('Crowd', abi), 'product.jar': source('Jar', []) },
  );
  assert.match(beyond.blocker, /first 64 functions/);
  assert.equal(beyond.composition, undefined);
});

test('a signature the ABI declares twice is not offered', async () => {
  // Duplicate option values are rejected wholesale by the host, and the
  // selection would be ambiguous against the authoritative ABI anyway.
  const abi = [
    fn('deploy', [{ name: 'salt', type: 'bytes32' }], [{ name: 'jar', type: 'address' }]),
    fn('deploy', [{ name: 'salt', type: 'bytes32' }], [{ name: 'jar', type: 'address' }]),
    CLONE,
  ];
  const data = await compose({}, { factory: source('Twice', abi) });
  assert.deepEqual(functionField(data).options.map((option) => option.value), ['clone()']);
  const selected = await compose(
    { address: ADDRESS, function: 'deploy(bytes32)' },
    { factory: source('Twice', abi), 'product.jar': source('Jar', []) },
  );
  assert.match(selected.blocker, /more than once/);
  assert.equal(selected.composition, undefined);
});

test('an unbounded client selection value cannot overflow the blocker cap', async () => {
  // `values` entries are only bounded in aggregate by the host, so a huge
  // stale selection must not be echoed into an over-cap blocker.
  const data = await compose(
    { address: ADDRESS, function: `deploy(${'uint256,'.repeat(2000)}uint8)` },
    { factory: source('Factory', FACTORY_ABI) },
  );
  assert.ok(data.blocker.length <= 500);
  assert.equal(data.composition, undefined);
});
