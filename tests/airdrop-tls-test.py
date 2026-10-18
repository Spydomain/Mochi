#!/usr/bin/env python3
"""Loopback-only TLS regressions against a supplied patched server.py.

Uses an ephemeral test certificate and synthetic consent handler, never the
radio, installed receiver, user's files, or production acceptance hook.
"""
import ast
from http.client import HTTPSConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import logging
from pathlib import Path
import platform
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest

REPO = Path(__file__).resolve().parents[1]
server_path = Path(sys.argv.pop(1))
tree = ast.parse(server_path.read_text())
spec = importlib.util.spec_from_file_location('opendrop.mochi_receive', REPO / 'windows/airdrop/mochi_receive.py')
receive = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = receive
spec.loader.exec_module(receive)
scope = dict(socket=socket, platform=platform, threading=threading,
             ThreadingHTTPServer=ThreadingHTTPServer, logger=logging.getLogger('tls-test'))
nodes = [next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'HTTPServerV6'),
         next(node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef) and node.name == '_init_server')]
exec(compile(ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[])), str(server_path), 'exec'),
     {**scope, '__package__': 'opendrop'}, scope)
# Methods retain the globals used by exec, so give them the completed scope.
scope['_init_server'].__globals__.update(scope)


class TLSTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix='mochi-tls-')
        cls.addClassCleanup(cls.temporary.cleanup)
        root = Path(cls.temporary.name)
        certificate, key = root / 'cert.pem', root / 'key.pem'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                        '-keyout', str(key), '-out', str(certificate), '-subj', '/CN=localhost',
                        '-days', '1'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cls.context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        cls.context.load_cert_chain(certificate, key)
        cls.client_context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        cls.client_context.check_hostname = False
        cls.client_context.verify_mode = ssl.CERT_NONE  # Only our ephemeral loopback fixture.

    def start(self, slots=8, timeout=30, hold_consent=None):
        self.entered = threading.Event()
        self.prompted = threading.Event()
        self.dispatched = threading.Event()
        self.finished = threading.Event()
        entered, prompted = self.entered, self.prompted
        dispatched, finished = self.dispatched, self.finished

        class Server(scope['HTTPServerV6']):
            address_family = socket.AF_INET
            MAX_TLS_HANDSHAKES = slots
            TLS_HANDSHAKE_TIMEOUT = timeout

            def get_request(self):
                entered.set()
                return super().get_request()

            def process_request(self, request, address):
                super().process_request(request, address)
                dispatched.set()

            def process_request_thread(self, request, address):
                try:
                    super().process_request_thread(request, address)
                finally:
                    finished.set()

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                if self.path != '/Ask':
                    self.send_error(404)
                    return
                prompted.set()
                if hold_consent is not None:
                    hold_consent.wait(2)
                self.send_response(200)
                self.send_header('Content-Length', '0')
                self.end_headers()

            def log_message(self, *_):
                pass

        fake = SimpleNamespace(ServerClass=Server, serveraddress=('127.0.0.1', 0), Handler=Handler,
                               config=SimpleNamespace(interface='lo', get_ssl_context=lambda: self.context))
        self.server = scope['_init_server'](fake)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': .01}, daemon=True)
        self.clients = []
        self.addCleanup(self.stop)

    def stop(self):
        # Release stalled handshakes before shutdown, including on the old
        # implementation where accept itself is blocked on the first client.
        for client in self.clients:
            client.close()
        if self.thread.ident is not None:
            self.server.shutdown()
        self.server.server_close()
        if self.thread.ident is not None:
            self.thread.join(2)
        self.assertFalse(self.thread.is_alive())

    def idle(self):
        client = socket.create_connection(self.server.server_address, timeout=2)
        self.clients.append(client)
        return client

    def ask(self):
        client = HTTPSConnection(*self.server.server_address, context=self.client_context, timeout=2)
        try:
            client.request('POST', '/Ask', body=b'')
            response = client.getresponse()
            self.assertEqual(response.status, 200)
            response.read()
        finally:
            client.close()

    def test_idle_first_tls_connection_does_not_block_the_consent_request(self):
        self.start()
        self.idle()
        self.thread.start()
        self.assertTrue(self.entered.wait(1))
        self.ask()
        self.assertTrue(self.prompted.is_set(), 'a preconnection must not suppress the first /Ask')

    def test_stalled_tls_handshake_expires_and_releases_its_slot(self):
        self.start(slots=1, timeout=.1)
        idle = self.idle()
        self.thread.start()
        self.assertTrue(self.dispatched.wait(1))
        self.assertTrue(self.finished.wait(1), 'TLS wait must have a bounded deadline')
        self.assertEqual(idle.recv(1), b'')
        self.ask()

    def test_invalid_tls_client_does_not_break_following_requests(self):
        self.start(slots=1)
        idle = self.idle()
        idle.sendall(b'not a TLS client\r\n')
        self.thread.start()
        self.assertTrue(self.finished.wait(1))
        self.ask()

    def test_unfinished_tls_connections_have_a_resource_limit(self):
        self.start(slots=2)
        self.idle()
        self.thread.start()
        self.assertTrue(self.dispatched.wait(1))
        self.dispatched.clear()
        self.idle()
        self.assertTrue(self.dispatched.wait(1))
        overflow = self.idle()
        self.assertEqual(overflow.recv(1), b'')
        self.assertFalse(self.prompted.is_set())

    def test_consent_wait_does_not_hold_a_tls_slot(self):
        release = threading.Event()
        self.start(slots=1, hold_consent=release)
        self.thread.start()
        errors = []

        def ask():
            try:
                self.ask()
            except BaseException as error:
                errors.append(error)

        client = threading.Thread(target=ask, daemon=True)
        client.start()
        try:
            self.assertTrue(self.prompted.wait(1))
            self.assertTrue(self.server._tls_slots.acquire(blocking=False))
            self.server._tls_slots.release()
        finally:
            release.set()
            client.join(2)
        self.assertFalse(client.is_alive())
        self.assertEqual(errors, [])


if __name__ == '__main__':
    unittest.main()
