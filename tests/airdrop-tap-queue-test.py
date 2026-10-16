#!/usr/bin/env python3
"""Exercise the root helper's TAP setup without touching interfaces or sudo."""
import pathlib
import subprocess
import sys
import tempfile

source = pathlib.Path(sys.argv[1]).read_text()
function_start = source.index('awdl_queue_tune() {')
function_end = source.index('\n}', function_start) + len('\n}')
function = source[function_start:function_end]
start = source.index('    if ip link show awdl0 >/dev/null 2>&1; then')
end = source.index('\n    fi', start) + len('\n    fi')
block = source[start:end]
mock = '''
ip() {
  printf 'ip %s\\n' "$*" >> "$MOCHI_TEST_LOG"
  case "$*" in
    'link show awdl0') return "$MOCHI_TEST_MISSING" ;;
    'link set dev awdl0 txqueuelen 8') return "$MOCHI_TEST_FAIL" ;;
  esac
}
'''
tc_mock = '''
MOCHI_TEST_TC_COUNT=0
tc() {
  printf 'tc %s\\n' "$*" >> "$MOCHI_TEST_LOG"
  MOCHI_TEST_TC_COUNT=$((MOCHI_TEST_TC_COUNT + 1))
  test "$MOCHI_TEST_TC_COUNT" != "$MOCHI_TEST_TC_FAIL"
}
'''
with tempfile.TemporaryDirectory(prefix='mochi-tap-test.') as directory:
    for missing, fail, tc_fail, no_tc in [
        (0, 0, 0, False), (0, 1, 0, False), (1, 0, 0, False),
        (0, 0, 1, False), (0, 0, 2, False), (0, 0, 3, False),
        (0, 0, 4, False), (0, 0, 0, True),
    ]:
        log = pathlib.Path(directory) / f'{missing}-{fail}-{tc_fail}-{no_tc}.log'
        result = subprocess.run(
            ['/bin/bash', '-c', mock + ('' if no_tc else tc_mock) + function + '\n' + block], text=True,
            capture_output=True,
            env={'PATH': '' if no_tc else '/usr/bin:/bin', 'MOCHI_TEST_LOG': str(log),
                 'MOCHI_TEST_MISSING': str(missing), 'MOCHI_TEST_FAIL': str(fail),
                 'MOCHI_TEST_TC_FAIL': str(tc_fail)},
        )
        calls = log.read_text().splitlines()
        if missing:
            assert result.returncode != 0 and '"awdl0":false' in result.stdout
            assert calls == ['ip link show awdl0']
        elif fail:
            assert result.returncode != 0 and '"awdl0":true' not in result.stdout
            assert calls == ['ip link show awdl0', 'ip link set dev awdl0 txqueuelen 8']
        else:
            assert result.returncode == 0 and '"awdl0":true' in result.stdout
            assert calls[:2] == ['ip link show awdl0', 'ip link set dev awdl0 txqueuelen 8']
            assert calls[-1] == 'ip link set awdl0 up'
            if no_tc:
                assert len(calls) == 3
            elif tc_fail:
                assert calls[-2] == 'tc qdisc del dev awdl0 root'
                assert 'ACK filtering unavailable' in result.stderr
            else:
                assert len(calls) == 7
                assert 'cake bandwidth 32kbit besteffort ack-filter' in calls[3]
                assert calls[4] == 'tc qdisc replace dev awdl0 parent 1:2 handle 20: fq_codel'
                assert 'flowid 1:1' in calls[5]
        assert all('awdl0' in call and 'wlan' not in call for call in calls)
print('AirDrop TAP/ACK queues, optional-kernel fallback and Wi-Fi isolation passed.')
