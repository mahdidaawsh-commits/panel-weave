const fs = require('node:fs');
const path = require('node:path');
const {root, assert, equal, digest, delay, sourceHash, invoke, read, rpc, receipt, receiptSummary, save} = require('./transport.cjs');
const {decodeReceipt} = require('./receipt-calldata.cjs');

const CHAIN = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971';
const GENESIS = 1692803367;
const PERIOD = 3;
const WINDOW = 360;
const HOSTS = ['https://api.drand.sh', 'https://drand.cloudflare.com'];

function permutations(list) {
  if (!list.length) return [[]];
  return list.flatMap((value, i) =>
    permutations(list.filter((_, j) => j !== i)).map(rest => [value, ...rest]));
}

function oracle(entries) {
  const indices = entries.map((_, i) => i);
  const edges = entries.map((entry, i) => indices.filter(j =>
    i !== j && !entry.exclusions.includes(entries[j].author)));
  return {edges, matches: permutations(indices).filter(order => order.every((j, i) => edges[i].includes(j)))};
}

function rootOf(entries) {
  return digest(JSON.stringify(entries.map(entry => ({
    author: entry.author, exclusions: entry.exclusions, submission_sha256: entry.submission_sha256,
  }))));
}

async function readBeacon(round) {
  const pulses = await Promise.all(HOSTS.map(async host => {
    const response = await fetch(host + '/' + CHAIN + '/public/' + round, {signal: AbortSignal.timeout(20000)});
    assert(response.ok, 'Beacon HTTP ' + response.status);
    const pulse = await response.json();
    assert(pulse.round === round && /^[a-f0-9]{96}$/.test(pulse.signature)
      && digest(Buffer.from(pulse.signature, 'hex')) === pulse.randomness, 'Invalid public pulse');
    return {signature: pulse.signature, randomness: pulse.randomness};
  }));
  assert(equal(pulses[0], pulses[1]), 'Public relay discrepancy');
  return pulses[0];
}

function expectedRank(contract, round, rootHash, pulse, count) {
  const domain = ['PanelWeave/v1', 61999, contract.toLowerCase(), round, rootHash, pulse.randomness];
  const seed = Buffer.from(digest(JSON.stringify(domain)), 'hex');
  const span = 1n << 256n;
  const choices = BigInt(count);
  for (let i = 0; i < 8; i++) {
    const value = BigInt('0x' + digest(Buffer.concat([seed, Buffer.from([i])])));
    if (value < span - span % choices) return Number(value % choices);
  }
  throw Error('Rank sampling exhausted');
}

async function main() {
  const scenario = process.env.PANEL_SCENARIO;
  assert(['assigned', 'impossible'].includes(scenario), 'Choose a supported scenario');
  const prefix = scenario + '-';
  const wallets = JSON.parse(process.env.PANEL_ACCOUNTS || '[]');
  assert(wallets.length === 5 && new Set(wallets.map(x => x.address)).size === 5, 'Five distinct wallets required');
  const [a, b, c, d] = wallets.map(x => x.address);
  const roster = [a, b, c, d];
  const exclusions = scenario === 'assigned' ? [[b], [], [d], []] : [[b, d], [a, d], [], []];
  const code = fs.readFileSync(path.join(root, 'contracts/panel_weave.py'));
  assert(await rpc('eth_chainId', []) === '0xf22f', 'StudioNet only');

  process.env.PANEL_ACCOUNT = wallets[4].name;
  const deployment = await invoke(prefix + 'deploy', ['deploy', '--contract', 'contracts/panel_weave.py',
    '--args', JSON.stringify(roster), String(WINDOW)]);
  const deployed = await receipt(prefix + 'deploy', deployment, true);
  const contract = deployed.to_address || deployed.recipient;
  assert(/^0x[0-9a-f]{40}$/i.test(contract), 'Missing deployed contract');
  assert(code.equals(Buffer.from(deployed.data.contract_code, 'base64')), 'Deployed source mismatch');
  const initial = await read(prefix + 'initial-state', ['call', contract, 'get_state']);
  const expected = {...initial, roster: roster.slice().sort(), entries: [], resolution: null};
  assert(equal(initial, expected), 'Invalid initial state');
  const {cutoff, beacon_time: beaconTime, beacon_round: round} = initial;
  assert(Number.isSafeInteger(cutoff) && cutoff > Date.now() / 1000
    && cutoff < Date.now() / 1000 + WINDOW + 20, 'Invalid enrollment cutoff');
  assert(beaconTime === GENESIS + (round - 1) * PERIOD
    && beaconTime >= cutoff + 120 && beaconTime < cutoff + 123, 'Invalid future round');
  const report = {scenario, contract, deployment, source_sha256: sourceHash, trace: []};

  async function verify(label, raw, actor, args, error = null) {
    const info = receiptSummary(raw);
    assert((raw.from_address || raw.sender).toLowerCase() === wallets[actor].address, 'Wrong receipt sender');
    assert((raw.to_address || raw.recipient).toLowerCase() === contract.toLowerCase(), 'Wrong receipt recipient');
    assert(equal(await decodeReceipt(raw), args), 'Unexpected signed calldata');
    if (error) {
      const payload = Buffer.from(raw.consensus_data.leader_receipt[0].result, 'base64');
      assert(payload[0] === 1 && payload.subarray(1).toString() === error, 'Wrong revert reason: ' + label);
    }
    const state = await read(prefix + label + '-state', ['call', contract, 'get_state']);
    if (!equal(state, expected)) save(prefix + 'state-mismatch', {label, state, expected});
    assert(equal(state, expected), 'Unexpected state after ' + label);
    report.trace.push({label, ...info, signer: wallets[actor].address, args, error, state});
    save(prefix + 'progress', report);
  }
  await verify('deploy', deployed, 4, {args: [roster, WINDOW]});

  async function write(label, actor, method, args, error, update = () => {}) {
    process.env.PANEL_ACCOUNT = wallets[actor].name;
    const cli = ['write', contract, method];
    if (args.length) cli.push('--args', ...args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)));
    const hash = await invoke(prefix + label, cli);
    const raw = await receipt(prefix + label, hash, !error);
    await update();
    await verify(label, raw, actor, {method, args}, error);
  }

  await write('early-draw', 4, 'draw', [], 'Enrollment open');
  for (let i = 0; i < roster.length; i++) {
    const entry = {author: roster[i], submission_sha256: digest('PanelWeave synthetic submission ' + i),
      exclusions: exclusions[i].slice().sort()};
    await write('enroll-' + i, i, 'enroll', [entry.submission_sha256, entry.exclusions], null, () => {
      expected.entries.push(entry);
      expected.entries.sort((left, right) => left.author.localeCompare(right.author));
    });
  }
  const target = scenario === 'assigned' ? beaconTime : cutoff;
  if (Date.now() < (target + 10) * 1000) {
    console.log('Waiting until', new Date((target + 10) * 1000).toISOString());
    await delay((target + 10) * 1000 - Date.now());
  }
  const rosterHash = rootOf(expected.entries);
  const {matches, edges} = oracle(expected.entries);
  await write('draw', 4, 'draw', [], null, async () => {
    if (scenario === 'assigned') {
      assert(matches.length > 1, 'Fixture must give randomness a consequential choice');
      const beacon = await readBeacon(round);
      const rank = expectedRank(contract, round, rosterHash, beacon, matches.length);
      const assignments = matches[rank].map((j, i) => ({
        reviewer: expected.entries[i].author, author: expected.entries[j].author,
        submission_sha256: expected.entries[j].submission_sha256,
      }));
      expected.resolution = {outcome: 'ASSIGNED', roster_sha256: rosterHash,
        matching_count: matches.length, rank, beacon, assignments};
    } else {
      assert(matches.length === 0, 'Independent oracle found a feasible matching');
      const indices = [a, b].map(address => expected.entries.findIndex(e => e.author === address));
      assert(indices.every(i => equal(edges[i].map(j => expected.entries[j].author), [c])),
        'Expected a two-reviewer Hall deficit');
      expected.resolution = {outcome: 'IMPOSSIBLE', roster_sha256: rosterHash,
        witness: {reviewers: [a, b].sort(), available_authors: [c]}};
    }
  });
  await write('late-withdraw', 0, 'withdraw', [], 'Enrollment closed');
  await write('replay', 4, 'draw', [], 'Panel already resolved');
  assert(code.equals(Buffer.from(await rpc('gen_getContractCode', [contract]), 'base64')), 'Fresh source read mismatch');
  save(prefix + 'verified', report);
  console.log(JSON.stringify({scenario, contract, deployment, receipts: report.trace.length, result: expected.resolution}));
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
