from datetime import datetime, timezone
from hashlib import sha256
from itertools import permutations
import json
import re

import pytest


CHAIN = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971'
HOSTS = ('https://api.drand.sh', 'https://drand.cloudflare.com')
START = '2026-01-02T00:00:00+00:00'


def warp(vm, seconds):
    vm.warp(datetime.fromtimestamp(seconds, timezone.utc).isoformat())


def setup(vm, deploy, accounts):
    vm.warp(START)
    roster = ['0x' + bytes(address).hex() for address in accounts[:4]]
    panel = deploy('contracts/panel_weave.py', list(accounts[:4]), 120, sdk_version='v0.2.16')
    return panel, roster


def enroll(vm, panel, accounts, exclusions):
    by_address = {'0x' + bytes(account).hex(): account for account in accounts[:4]}
    for i, blocked in enumerate(exclusions):
        vm.sender = accounts[i]
        panel.enroll(sha256(str(i).encode()).hexdigest(), [by_address[address] for address in blocked])


def mock_beacon(vm, round_number, signature='12' * 48, second=None, wrong_round=False, bad_hash=False):
    vm.clear_mocks()
    for host, sig in zip(HOSTS, (signature, second or signature)):
        url = f'{host}/{CHAIN}/public/{round_number}'
        vm.mock_web(re.escape(url), {'status': 200, 'body': json.dumps({
            'round': round_number + int(wrong_round), 'signature': sig,
            'randomness': '0' * 64 if bad_hash else sha256(bytes.fromhex(sig)).hexdigest(),
        }).encode()})


@pytest.mark.parametrize('conflicts', [False, True])
def test_rank_selects_exact_match_from_independent_oracle(direct_vm, direct_deploy, direct_accounts, conflicts):
    panel, roster = setup(direct_vm, direct_deploy, direct_accounts)
    enroll(direct_vm, panel, direct_accounts, [[roster[1]] if conflicts else [], [], [], []])
    state = panel.get_state()
    assert 120 <= state['beacon_time'] - state['cutoff'] <= 122
    warp(direct_vm, state['beacon_time'])
    mock_beacon(direct_vm, state['beacon_round'])
    direct_vm.sender = direct_accounts[4]
    panel.draw()
    assert direct_vm.run_validator() is True
    result = panel.get_state()['resolution']
    entries = state['entries']
    valid = [
        targets for targets in permutations(range(len(entries)))
        if all(i != j and entries[j]['author'] not in entries[i]['exclusions']
               for i, j in enumerate(targets))
    ]
    assert result['matching_count'] == len(valid)
    for row, reviewer, target in zip(result['assignments'], entries, valid[result['rank']]):
        assert row == {'reviewer': reviewer['author'], 'author': entries[target]['author'],
                       'submission_sha256': entries[target]['submission_sha256']}
    assert result['beacon']['randomness'] == sha256(bytes.fromhex('12' * 48)).hexdigest()
    with direct_vm.expect_revert('Panel already resolved'):
        panel.draw()


def test_hall_deficit_is_checkable_without_beacon(direct_vm, direct_deploy, direct_accounts):
    panel, roster = setup(direct_vm, direct_deploy, direct_accounts)
    enroll(direct_vm, panel, direct_accounts, [[roster[1], roster[3]], [roster[0], roster[3]], [], []])
    warp(direct_vm, panel.get_state()['cutoff'])
    panel.draw()
    result = panel.get_state()['resolution']
    assert result['outcome'] == 'IMPOSSIBLE'
    assert result['witness'] == {'reviewers': sorted(roster[:2]), 'available_authors': [roster[2]]}


def test_freeze_precedes_entropy_and_withdrawal_removes_consent(direct_vm, direct_deploy, direct_accounts):
    panel, roster = setup(direct_vm, direct_deploy, direct_accounts)
    enroll(direct_vm, panel, direct_accounts, [[], [], [], []])
    with direct_vm.expect_revert('Enrollment open'):
        panel.draw()
    panel.withdraw()
    assert roster[3] not in [e['author'] for e in panel.get_state()['entries']]
    warp(direct_vm, panel.get_state()['cutoff'])
    with direct_vm.expect_revert('Enrollment closed'):
        panel.enroll('e' * 64, [])
    direct_vm.sender = direct_accounts[0]
    with direct_vm.expect_revert('Enrollment closed'):
        panel.withdraw()
    with direct_vm.expect_revert('Beacon not due'):
        panel.draw()
    assert panel.get_state()['resolution'] is None


def test_malformed_or_unapproved_enrollment_changes_no_state(direct_vm, direct_deploy, direct_accounts):
    panel, roster = setup(direct_vm, direct_deploy, direct_accounts)
    direct_vm.sender = direct_accounts[4]
    with direct_vm.expect_revert('Not eligible'):
        panel.enroll('a' * 64, [])
    direct_vm.sender = direct_accounts[0]
    with direct_vm.expect_revert('Invalid exclusions'):
        panel.enroll('a' * 64, [direct_accounts[0]])
    with direct_vm.expect_revert('Invalid submission commitment'):
        panel.enroll('a', [])
    assert panel.get_state()['entries'] == []


@pytest.mark.parametrize(('options', 'error'), [
    ({'second': '34' * 48}, 'Beacon relays disagree'),
    ({'wrong_round': True}, 'Beacon round mismatch'),
    ({'bad_hash': True}, 'Beacon digest mismatch'),
])
def test_beacon_failures_do_not_resolve(direct_vm, direct_deploy, direct_accounts, options, error):
    panel, _ = setup(direct_vm, direct_deploy, direct_accounts)
    enroll(direct_vm, panel, direct_accounts, [[], [], [], []])
    state = panel.get_state()
    warp(direct_vm, state['beacon_time'])
    mock_beacon(direct_vm, state['beacon_round'], **options)
    with direct_vm.expect_revert(error):
        panel.draw()
    assert panel.get_state()['resolution'] is None


def test_validator_rejects_alternate_pulse_even_with_two_agreeing_relays(direct_vm, direct_deploy, direct_accounts):
    panel, _ = setup(direct_vm, direct_deploy, direct_accounts)
    enroll(direct_vm, panel, direct_accounts, [[], [], [], []])
    state = panel.get_state()
    warp(direct_vm, state['beacon_time'])
    mock_beacon(direct_vm, state['beacon_round'])
    panel.draw()
    mock_beacon(direct_vm, state['beacon_round'], signature='ab' * 48)
    assert direct_vm.run_validator() is False


def test_too_few_members_needs_no_entropy(direct_vm, direct_deploy, direct_accounts):
    panel, _ = setup(direct_vm, direct_deploy, direct_accounts)
    enroll(direct_vm, panel, direct_accounts, [[], []])
    warp(direct_vm, panel.get_state()['cutoff'])
    panel.draw()
    assert panel.get_state()['resolution']['outcome'] == 'INSUFFICIENT'
