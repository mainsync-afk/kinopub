#!/usr/bin/env python3
"""
kp2_log_server.py — простой HTTP-приёмник логов от kp2.js на ТВ.

Запуск на ПК:
    python kp2_log_server.py            # порт 8765
    python kp2_log_server.py 9000        # свой порт

Включение на стороне ТВ (через Lampa Terminal):
    Lampa.Storage.set('kp2_log_url', 'http://<IP_ПК>:8765/l')
    location.reload()

После этого все console.log/warn/error/info из kp2.js + любые window.error и
Promise rejection'ы прилетают сюда в реалтайме.

Сервер принимает и GET (через `<Image>` чтобы обойти CORS на старых Tizen WebView)
и POST (для совместимости с fetch-ом на новых браузерах).
"""

import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs


class Handler(BaseHTTPRequestHandler):
    # глушим встроенный access-лог — он шумный и нам не нужен
    def log_message(self, *args, **kwargs):
        pass

    def _no_content(self):
        # 204 + CORS-заголовки чтобы fetch с других origin не зарубался
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()

    def _print(self, payload: str):
        ts = time.strftime('%H:%M:%S')
        ip = self.client_address[0]
        print(f'[{ts}] {ip}  {payload}', flush=True)

    def do_OPTIONS(self):
        self._no_content()

    def do_GET(self):
        qs = parse_qs(urlparse(self.path).query)
        msg = qs.get('d', [''])[0]
        if msg:
            self._print(msg)
        # GET от Image() — отвечать любым успешным
        self._no_content()

    def do_POST(self):
        length = int(self.headers.get('content-length', 0) or 0)
        body = self.rfile.read(length).decode('utf-8', errors='replace') if length > 0 else ''
        if body:
            self._print(body)
        self._no_content()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    addr = ('0.0.0.0', port)
    print(f'kp2 log server listening on {addr[0]}:{addr[1]}', flush=True)
    print(f'enable on TV (Lampa Terminal):', flush=True)
    print(f'  Lampa.Storage.set(\'kp2_log_url\', \'http://<your_pc_ip>:{port}/l\'); location.reload()', flush=True)
    print('---', flush=True)
    try:
        HTTPServer(addr, Handler).serve_forever()
    except KeyboardInterrupt:
        print('\nstopped.', flush=True)
