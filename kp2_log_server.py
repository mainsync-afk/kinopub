#!/usr/bin/env python3
"""
kp2_log_server.py — HTTP-приёмник логов от kp2.js на ТВ.

Запуск на ПК:
    python kp2_log_server.py            # порт 8765
    python kp2_log_server.py 9000        # свой порт

Включение на стороне ТВ (через Lampa Terminal или хардкод в kp2.js):
    Lampa.Storage.set('kp2_log_url', 'http://<IP_ПК>:8765/l')
    location.reload()

Поддерживаемые точки:
  GET/POST /l     — single-line реалтайм-лог из console.log
                    (через Image() GET — обход CORS на старых Tizen WebView)
  POST     /dump  — bulk-выгрузка Lampa.Console.export() в JSON.
                    kp2.js шлёт сюда раз в 30 секунд (либо вручную через
                    window.kp2_dump('reason')). На диск кладётся
                    lampa_logs_<HHMMSS>.json + краткое summary в stdout.
"""

import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs


DUMP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lampa_dumps')
os.makedirs(DUMP_DIR, exist_ok=True)


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
        path = urlparse(self.path).path
        length = int(self.headers.get('content-length', 0) or 0)
        body = self.rfile.read(length).decode('utf-8', errors='replace') if length > 0 else ''

        if path == '/dump':
            self._handle_dump(body)
            self._no_content()
            return

        # Дефолтная ветка: одиночное сообщение, как из GET (на случай если
        # на каком-то Tizen WebView fetch вместо GET через Image)
        if body:
            self._print(body)
        self._no_content()

    # ----------------------------------------------------------------------

    def _handle_dump(self, body: str):
        """Принять JSON-выгрузку Lampa.Console.export() и положить на диск."""
        try:
            payload = json.loads(body)
        except Exception as e:
            self._print(f'DUMP parse error: {e}; body[:200]={body[:200]!r}')
            return

        ts_human = time.strftime('%Y%m%d_%H%M%S')
        reason = payload.get('reason', '?')
        plugin_v = payload.get('plugin_version', '?')
        logs = payload.get('logs') or {}

        filename = os.path.join(DUMP_DIR, f'lampa_logs_{ts_human}_{reason}.json')
        try:
            with open(filename, 'w', encoding='utf-8') as f:
                json.dump(payload, f, ensure_ascii=False, indent=2)
        except Exception as e:
            self._print(f'DUMP write error: {e}')
            return

        # Summary в stdout
        ts = time.strftime('%H:%M:%S')
        ip = self.client_address[0]
        total_groups = len(logs)
        total_entries = sum(len(v) for v in logs.values() if isinstance(v, list))
        print(f'[{ts}] {ip}  DUMP saved → {os.path.basename(filename)}  '
              f'(plugin={plugin_v}, reason={reason}, groups={total_groups}, entries={total_entries})',
              flush=True)

        # Покажем последнее значение для каждой kp2-группы и для Errors
        priority_prefixes = ('[kp2', 'Errors', 'Warnings')
        priority_groups = []
        other_groups = []
        for name in logs.keys():
            if any(name.startswith(p) for p in priority_prefixes):
                priority_groups.append(name)
            else:
                other_groups.append(name)

        for name in sorted(priority_groups):
            entries = logs.get(name) or []
            count = len(entries)
            if count == 0:
                continue
            last = entries[0]  # Lampa вставляет новые в начало
            t = last.get('time')
            t_str = time.strftime('%H:%M:%S', time.localtime(t / 1000)) if t else '????????'
            msg_parts = last.get('message') or []
            preview = ' '.join(str(m) for m in msg_parts)
            preview = preview.replace('\n', ' ')[:160]
            short_name = (name[:50] + '...') if len(name) > 53 else name
            print(f'    {t_str} [{short_name:53}] ({count:3d}) | {preview}', flush=True)

        # Только сводка по остальным
        if other_groups:
            counts = ', '.join(f'{n}({len(logs[n])})' for n in other_groups[:8])
            extra = '' if len(other_groups) <= 8 else f' +{len(other_groups) - 8} more'
            print(f'    other: {counts}{extra}', flush=True)
        print('---', flush=True)


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    addr = ('0.0.0.0', port)
    print(f'kp2 log server listening on {addr[0]}:{addr[1]}', flush=True)
    print(f'  /l    — single line console.log feed', flush=True)
    print(f'  /dump — bulk Lampa.Console.export() (JSON) → {DUMP_DIR}\\', flush=True)
    print(f'enable on TV (если ещё нет хардкода в kp2.js):', flush=True)
    print(f'  Lampa.Storage.set(\'kp2_log_url\', \'http://<your_pc_ip>:{port}/l\'); location.reload()', flush=True)
    print('---', flush=True)
    try:
        HTTPServer(addr, Handler).serve_forever()
    except KeyboardInterrupt:
        print('\nstopped.', flush=True)
