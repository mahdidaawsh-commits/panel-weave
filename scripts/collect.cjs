const fs = require('node:fs');
const path = require('node:path');
const {root, assert, digest, equal, sourceHash, receiptSummary, save} = require('./transport.cjs');

const runs = process.argv.slice(2);
const scenarios = ['assigned', 'impossible'];
const steps = ['deploy', 'early-draw', 'enroll-0', 'enroll-1', 'enroll-2', 'enroll-3',
  'draw', 'late-withdraw', 'replay'];
const errors = {'early-draw': 'Enrollment open', 'late-withdraw': 'Enrollment closed',
  replay: 'Panel already resolved'};
const explorer = 'https://explorer-studio.genlayer.com/';
const repo = 'https://github.com/mahdidaawsh-commits/panel-weave';
assert(runs.length === 2 && runs.every(id => /^\d+$/.test(id)) && runs[0] !== runs[1],
  'Pass the completed assigned and impossible workflow run IDs');

const results = [];
const files = [];
for (const [i, scenario] of scenarios.entries()) {
  const folder = path.join(root, '.proof-journal', 'run-' + runs[i]);
  const read = label => JSON.parse(fs.readFileSync(path.join(folder, scenario + '-' + label + '.json')));
  const report = read('verified');
  assert(report.scenario === scenario && report.source_sha256 === sourceHash, 'Proof source mismatch');
  assert(equal(report.trace.map(item => item.label), steps), 'Unexpected trace');
  let previous;
  for (const step of report.trace) {
    const raw = read(step.label + '-receipt');
    const item = receiptSummary(raw);
    assert(item.hash === step.hash && item.status === 'FINALIZED' && item.result === 'MAJORITY_AGREE'
      && item.agree > (item.agree + item.disagree + item.idle) / 2, 'Finalized strict majority required');
    assert((raw.from_address || raw.sender).toLowerCase() === step.signer
      && (raw.to_address || raw.recipient).toLowerCase() === report.contract.toLowerCase(), 'Receipt identity mismatch');
    const error = errors[step.label];
    if (error) {
      const payload = Buffer.from(raw.consensus_data.leader_receipt[0].result, 'base64');
      assert(item.execution === 'ERROR' && payload[0] === 1 && payload.subarray(1).toString() === error
        && equal(step.state, previous), 'Expected rejection with unchanged state');
    } else {
      assert(['SUCCESS', 'FINISHED_WITH_RETURN'].includes(item.execution), 'Expected successful execution');
    }
    if (step.label === 'deploy') {
      assert(item.hash === report.deployment && digest(Buffer.from(raw.data.contract_code, 'base64')) === sourceHash,
        'Deployment source mismatch');
    }
    if (step.label.startsWith('enroll-')) {
      assert(step.state.entries.length === previous.entries.length + 1
        && step.state.entries.some(entry => entry.author === step.signer), 'Missing signed enrollment');
    }
    previous = step.state;
    files.push([scenario + '-' + step.label + '-receipt', raw]);
  }
  const draw = report.trace.find(step => step.label === 'draw');
  const result = draw.state.resolution;
  assert(result.outcome === scenario.toUpperCase() && draw.state.entries.length === 4, 'Wrong draw result');
  results.push({scenario, contract: report.contract, deployment: report.deployment, draw: draw.hash,
    cutoff: draw.state.cutoff, beacon_round: draw.state.beacon_round, result,
    workflow: repo + '/actions/runs/' + runs[i]});
  files.push([scenario + '-verified', report]);
}
for (const [name, value] of files) save(name, value);
save('index', {source_sha256: sourceHash, finalized_receipts: 18, successful_calls: 12,
  expected_rejections: 6, instances: results});
const rows = results.map(item => '| ' + [
  item.scenario, '[Contract](' + explorer + 'address/' + item.contract + ')',
  '[Deploy](' + explorer + 'tx/' + item.deployment + ')',
  '[Draw](' + explorer + 'tx/' + item.draw + ')', '[Run](' + item.workflow + ')',
].join(' | ') + ' |');
const {beacon_round: beaconRound, result} = results[0];
fs.writeFileSync(path.join(root, 'proofs/README.md'), [
  '# PanelWeave StudioNet proofs', '',
  'Verified 18 finalized receipts across two four-person panels. The traces include 12 successful calls and six expected rejections.', '',
  '| Scenario | Address | Deployment | Draw | Workflow |', '|---|---|---|---|---|', ...rows, '',
  'The assigned panel independently checked ' + result.matching_count + ' feasible matchings and selected rank '
    + result.rank + ' from quicknet round ' + beaconRound + '. The impossible panel verified a two-reviewer Hall deficit.', '',
  'Source SHA-256: `' + sourceHash + '`.', '',
].join('\n'));
console.log(JSON.stringify({sourceHash, results}, null, 2));
