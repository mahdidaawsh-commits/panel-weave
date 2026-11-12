# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
from genlayer import *
from datetime import datetime, timezone
from hashlib import sha256
import json
import re


CHAIN = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971'
GENESIS = 1692803367
PERIOD = 3
BEACON_GAP = 120
RELAYS = ('https://api.drand.sh', 'https://drand.cloudflare.com')
ZERO = '0x' + '0' * 40


def fail(message):
    raise gl.vm.UserError(message)


def now():
    return int(datetime.now(timezone.utc).timestamp())


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'))


def commitment(value):
    return sha256(canonical(value).encode()).hexdigest()


def feasible_edges(entries):
    return [
        [j for j, candidate in enumerate(entries)
         if i != j and candidate['author'] not in entry['exclusions']]
        for i, entry in enumerate(entries)
    ]


def completion_counts(edges):
    """Count suffix matchings for each mask of already assigned submissions."""
    full = (1 << len(edges)) - 1
    counts = [0] * (full + 1)
    counts[full] = 1
    for mask in range(full - 1, -1, -1):
        for target in edges[mask.bit_count()]:
            bit = 1 << target
            if not mask & bit:
                counts[mask] += counts[mask | bit]
    return counts


def unrank(edges, counts, rank):
    """Lexicographic unranking, weighted by exact completion counts."""
    used = 0
    targets = []
    for options in edges:
        for target in options:
            bit = 1 << target
            if used & bit:
                continue
            ways = counts[used | bit]
            if rank < ways:
                targets.append(target)
                used |= bit
                break
            rank -= ways
    return targets


def hall_witness(entries, edges):
    size = len(entries)
    for count in range(1, size + 1):
        for mask in range(1, 1 << size):
            if mask.bit_count() != count:
                continue
            reviewers = [i for i in range(size) if mask & (1 << i)]
            neighbors = sorted({j for i in reviewers for j in edges[i]})
            if len(neighbors) < count:
                return {'reviewers': [entries[i]['author'] for i in reviewers],
                        'available_authors': [entries[i]['author'] for i in neighbors]}
    fail('Missing Hall witness')


def uniform_rank(seed, count):
    span = 1 << 256
    limit = span - span % count
    for counter in range(8):
        value = int.from_bytes(sha256(seed + bytes([counter])).digest(), 'big')
        if value < limit:
            return value % count
    fail('Rank sampling exhausted')


def observe_beacon(round_number):
    def sample():
        readings = []
        for host in RELAYS:
            url = host + '/' + CHAIN + '/public/' + str(round_number)
            try:
                reply = gl.nondet.web.get(url)
                if reply.status != 200 or len(reply.body) > 2048:
                    fail('Beacon unavailable')
                data = json.loads(reply.body)
            except Exception:
                fail('Beacon unavailable')
            if not isinstance(data, dict) or type(data.get('round')) is not int or data['round'] != round_number:
                fail('Beacon round mismatch')
            signature, randomness = data.get('signature'), data.get('randomness')
            if (not isinstance(signature, str) or not re.fullmatch(r'[a-fA-F0-9]{96}', signature)
                    or not isinstance(randomness, str)
                    or sha256(bytes.fromhex(signature)).hexdigest() != randomness.lower()):
                fail('Beacon digest mismatch')
            readings.append({'signature': signature.lower(), 'randomness': randomness.lower()})
        if readings[0] != readings[1]:
            fail('Beacon relays disagree')
        return readings[0]

    def validate(leader):
        if not isinstance(leader, gl.vm.Return):
            return False
        try:
            return sample() == leader.calldata
        except Exception:
            return False

    return gl.vm.run_nondet_unsafe(sample, validate)


class PanelWeave(gl.Contract):
    roster: str
    cutoff: u256
    beacon_round: u256
    beacon_time: u256
    entries: TreeMap[str, str]
    resolution: str

    def __init__(self, roster: list[Address], enrollment_seconds: int):
        if not 3 <= len(roster) <= 8:
            fail('Invalid roster')
        addresses = ['0x' + bytes(address).hex() for address in roster]
        if len(set(addresses)) != len(addresses) or ZERO in addresses:
            fail('Invalid roster')
        if not 120 <= enrollment_seconds <= 86_400:
            fail('Invalid enrollment duration')
        cutoff = now() + enrollment_seconds
        first_time = cutoff + BEACON_GAP
        round_number = (first_time - GENESIS + PERIOD - 1) // PERIOD + 1
        self.roster = canonical(sorted(addresses))
        self.cutoff = u256(cutoff)
        self.beacon_round = u256(round_number)
        self.beacon_time = u256(GENESIS + (round_number - 1) * PERIOD)
        self.resolution = 'null'

    @gl.public.write
    def enroll(self, submission_sha256: str, exclusions: list[Address]) -> None:
        if now() >= int(self.cutoff):
            fail('Enrollment closed')
        address = str(gl.message.sender_address).lower()
        roster = json.loads(self.roster)
        if address not in roster:
            fail('Not eligible')
        if address in self.entries:
            fail('Already enrolled')
        if not re.fullmatch(r'[a-f0-9]{64}', submission_sha256):
            fail('Invalid submission commitment')
        if len(exclusions) >= len(roster):
            fail('Invalid exclusions')
        blocked = ['0x' + bytes(other).hex() for other in exclusions]
        if len(set(blocked)) != len(blocked) or any(x == address or x not in roster for x in blocked):
            fail('Invalid exclusions')
        self.entries[address] = canonical({'author': address, 'submission_sha256': submission_sha256,
                                           'exclusions': sorted(blocked)})

    @gl.public.write
    def withdraw(self) -> None:
        if now() >= int(self.cutoff):
            fail('Enrollment closed')
        address = str(gl.message.sender_address).lower()
        if address not in self.entries:
            fail('Not enrolled')
        del self.entries[address]

    def _active(self):
        return [json.loads(self.entries[address]) for address in json.loads(self.roster)
                if address in self.entries]

    @gl.public.write
    def draw(self) -> None:
        if self.resolution != 'null':
            fail('Panel already resolved')
        if now() < int(self.cutoff):
            fail('Enrollment open')
        entries = self._active()
        root = commitment(entries)
        if len(entries) < 3:
            self.resolution = canonical({'outcome': 'INSUFFICIENT', 'roster_sha256': root})
            return
        edges = feasible_edges(entries)
        counts = completion_counts(edges)
        if not counts[0]:
            self.resolution = canonical({'outcome': 'IMPOSSIBLE', 'roster_sha256': root,
                                         'witness': hall_witness(entries, edges)})
            return
        if now() < int(self.beacon_time):
            fail('Beacon not due')
        round_number = int(self.beacon_round)
        beacon = observe_beacon(round_number)
        domain = ['PanelWeave/v1', int(gl.message.chain_id), str(gl.message.contract_address).lower(),
                  round_number, root, beacon['randomness']]
        rank = uniform_rank(sha256(canonical(domain).encode()).digest(), counts[0])
        targets = unrank(edges, counts, rank)
        assignments = [{'reviewer': entry['author'], 'author': entries[j]['author'],
                        'submission_sha256': entries[j]['submission_sha256']}
                       for entry, j in zip(entries, targets)]
        self.resolution = canonical({'outcome': 'ASSIGNED', 'roster_sha256': root,
                                     'matching_count': counts[0], 'rank': rank, 'beacon': beacon,
                                     'assignments': assignments})

    @gl.public.view
    def get_state(self) -> dict:
        return {'roster': json.loads(self.roster), 'entries': self._active(),
                'cutoff': int(self.cutoff), 'beacon_time': int(self.beacon_time),
                'beacon_round': int(self.beacon_round), 'resolution': json.loads(self.resolution)}
