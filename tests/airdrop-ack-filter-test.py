#!/usr/bin/env python3
"""Validate the actual root helper's cBPF classifier using libpcap, no radio."""
import ctypes
import ctypes.util
import pathlib
import re
import struct
import sys

helper = pathlib.Path(sys.argv[1]).read_text()
program = re.search(r"local ack_filter='([^']+)'", helper).group(1)
fields = program.split(',')
instructions = [tuple(map(int, row.split())) for row in fields[1:]]
assert len(instructions) == int(fields[0])

class Instruction(ctypes.Structure):
    _fields_ = [('code', ctypes.c_ushort), ('jt', ctypes.c_ubyte),
                ('jf', ctypes.c_ubyte), ('k', ctypes.c_uint32)]

class Program(ctypes.Structure):
    _fields_ = [('length', ctypes.c_uint), ('instructions', ctypes.POINTER(Instruction))]

class Timeval(ctypes.Structure):
    _fields_ = [('seconds', ctypes.c_long), ('microseconds', ctypes.c_long)]

class Header(ctypes.Structure):
    _fields_ = [('time', Timeval), ('caplen', ctypes.c_uint32), ('length', ctypes.c_uint32)]

library = ctypes.CDLL(ctypes.util.find_library('pcap') or 'libpcap.so')
library.pcap_offline_filter.argtypes = [ctypes.POINTER(Program), ctypes.POINTER(Header), ctypes.c_void_p]
library.pcap_offline_filter.restype = ctypes.c_uint32
code = (Instruction * len(instructions))(*(Instruction(*row) for row in instructions))
compiled = Program(len(code), code)

def classify(packet):
    data = ctypes.create_string_buffer(packet)
    return library.pcap_offline_filter(ctypes.byref(compiled),
        ctypes.byref(Header(Timeval(0, 0), len(packet), len(packet))), data)

def packet(*, source=8771, flags=0x10, options=b'', data=b'', protocol=6, ethertype=0x86dd):
    assert len(options) % 4 == 0
    tcp = struct.pack('!HHIIBBHHH', source, 54321, 123, 456,
                      ((20 + len(options)) // 4) << 4, flags, 32768, 0, 0)
    payload = tcp + options + data
    ip6 = struct.pack('!IHBB16s16s', 6 << 28, len(payload), protocol, 64,
                      b'\x01' * 16, b'\x02' * 16)
    return b'\x02' * 12 + struct.pack('!H', ethertype) + ip6 + payload

cases = [
    ('plain receiver ACK', {}, True),
    ('timestamp ACK', {'options': b'\x01\x01\x08\x0a' + b'\x00' * 8}, True),
    ('SACK-bearing ACK', {'options': b'\x01\x01\x05\x0a' + b'\x00' * 8}, True),
    ('ECN ACK', {'flags': 0x50}, True),
    ('file data without PSH', {'data': b'payload' * 100}, False),
    ('file data with PSH', {'data': b'payload' * 100, 'flags': 0x18}, False),
    ('one-byte data', {'data': b'x'}, False),
    ('other TCP sender', {'source': 54321}, False),
    ('SYN ACK', {'flags': 0x12}, False),
    ('FIN ACK', {'flags': 0x11}, False),
    ('RST ACK', {'flags': 0x14}, False),
    ('UDP discovery', {'protocol': 17}, False),
    ('IPv6 neighbor discovery', {'protocol': 58}, False),
    ('IPv6 fragment header', {'protocol': 44}, False),
    ('IPv4', {'ethertype': 0x0800}, False),
]
for label, arguments, expected in cases:
    result = classify(packet(**arguments))
    assert result == (0xffffffff if expected else 0), (label, result)
plain = packet()
# A truncated packet must never be treated as a complete TCP header.
# The classifier accesses fields only through byte 67; it need not access
# the checksum/urgent-pointer tail to establish zero payload, so test every
# truncation up to the final field it actually uses.
for end in range(68):
    assert classify(plain[:end]) == 0, end
print(f'ACK-only classifier passed {len(cases)} traffic cases and 68 truncation checks.')
