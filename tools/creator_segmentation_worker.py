"""One-shot offline worker for the Creator's configured external GPU runtime."""
import argparse
import json
from pathlib import Path
import threading
import urllib.request
import urllib.error
from http.server import HTTPServer


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    request = json.loads(args.request.read_text(encoding='utf-8'))
    import birefnet_service as service
    from model_adapters import create_adapter
    operation = request['operation']
    if operation not in ('capabilities', 'segment', 'package-still'):
        raise ValueError('Unsupported operation')
    adapter = None if operation == 'package-still' else create_adapter(
        request['adapter'], args.output.parent / 'module-cache', 1024,
        service.MAX_BODY, service.MAX_PIXELS)
    server = HTTPServer(('127.0.0.1', 0), service.handler_type(adapter, 0))
    server.RequestHandlerClass = service.handler_type(adapter, server.server_port)
    thread = threading.Thread(target=server.handle_request, daemon=True)
    thread.start()
    body = (args.request.parent / 'input.bin').read_bytes() if operation != 'capabilities' else None
    headers = {'Origin': 'http://127.0.0.1:4173', 'Content-Type': request.get('contentType', 'image/png')}
    if request.get('prompts') is not None:
        headers['X-Segment-Prompts'] = request['prompts']
    wire = urllib.request.Request(f'http://127.0.0.1:{server.server_port}/api/{operation}', data=body, headers=headers)
    try:
        try:
            response = urllib.request.build_opener(urllib.request.ProxyHandler({})).open(wire, timeout=140)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            args.output.write_bytes(response.read())
            args.output.with_suffix('.meta.json').write_text(json.dumps({
                'status': response.code, 'contentType': response.headers['Content-Type']}), encoding='utf-8')
        thread.join(timeout=2)
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
